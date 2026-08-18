/**
 * @lanbaolu/dsh-wechat-bridge — DSH 微信桥接插件（hybrid）。
 *
 * Host 侧：
 *  - 启动一个仅监听 127.0.0.1 的内部 HTTP + SSE 服务，供桥接守护进程调用；
 *  - 用 DSH 自身 Agent（ctx.agents）处理微信转发来的消息；
 *  - 提供 wechat_bridge_* 工具与可选的 Web 面板同源路由。
 *
 * 三端通用：Windows / macOS / Linux 都使用纯 Node 进程管理（PID 文件 +
 * spawn/kill），不依赖 launchd/systemd。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, statSync, unlinkSync, chmodSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'

// Pull in Context augmentation for agents/session/default-model/workspace events.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { startQrLogin, checkQrStatus } from './bridge/wechat/login.js'
import { loadJson, saveJson, validateAccountId } from './bridge/store.js'

export const name = '@lanbaolu/dsh-wechat-bridge'

/** Host services the plugin needs. `webServer` is optional (headless profiles). */
export const inject = ['tools', 'agents', 'agentDefaultModel']

export interface Config {
  /** Data directory for accounts/sessions/logs. */
  dataDir: string
  /** Internal API bind host; keep loopback for safety. */
  host: string
  /** Internal API port; 0 = OS-assigned. */
  port: number
  /** Auto-start bridge daemon when the plugin loads. */
  autoStart: boolean
  /** Provider route for the DSH agent created per WeChat account. */
  provider: string
  /** Default model for the DSH agent created per WeChat account. */
  model: string
  /** Default workspace for the DSH agent created per WeChat account. */
  workingDirectory: string
}

export const Config = z.object({
  dataDir: z.string().default(''),
  host: z.string().default('127.0.0.1'),
  port: z.number().min(0).max(65535).default(0),
  autoStart: z.boolean().default(true),
  provider: z.string().default(''),
  model: z.string().default(''),
  workingDirectory: z.string().default(''),
})

interface StreamEvent {
  type: 'chunk' | 'done' | 'error' | 'status'
  text?: string
  sessionId?: string
  message?: string
  turn?: number
}

interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface ProjectSessionItem {
  sessionId: string
  workspaceId: string
  workspaceTitle: string
  path: string
  cwd?: string
  createdAt: string
  live: boolean
}

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function defaultDataDir(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function apply(ctx: Context, config: Config): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dataDir = config.dataDir || join(dshHome, 'wechat-bridge')
  const daemonLogPath = join(dataDir, 'logs', 'daemon.log')
  const pidPath = join(dataDir, 'daemon.pid')

  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(dataDir, 'logs'), { recursive: true })

  const token = randomBytes(24).toString('hex')
  const pluginLogPath = join(dataDir, 'plugin.log')

  function debugLog(message: string, data?: unknown): void {
    try {
      mkdirSync(dataDir, { recursive: true })
      const line = `[${new Date().toISOString()}] ${message}${data === undefined ? '' : ' ' + JSON.stringify(data)}\n`
      appendFileSync(pluginLogPath, line, 'utf8')
    } catch {
      // ignore
    }
  }

  const agents = new Map<string, AgentHandle>()
  /** Maps the WeChat-facing account id (used by the daemon) to the real DSH session id. */
  const sessionIds = new Map<string, string>()
  const activeSessionIds = new Set<string>()
  const creating = new Map<string, Promise<AgentHandle>>()
  const streamClients = new Map<string, Set<ServerResponse>>()
  /** Accounts waiting to switch to a selected project after the current turn ends. */
  const pendingProjectSwitches = new Set<string>()
  let bridgeChild: ChildProcess | undefined
  let bridgeStartedAt: number | undefined
  let internalServer: ReturnType<typeof createServer> | undefined
  let internalPort = 0
  let pendingSetup: { qrcodeId: string; workingDirectory: string } | undefined

  // -------------------------------------------------------------------------
  // DSH session id persistence (cross-restart continuation)
  // -------------------------------------------------------------------------

  const sessionIdMapPath = join(dataDir, 'session-ids.json')

  function loadSessionIdMap(): Record<string, string> {
    try {
      const raw = JSON.parse(readFileSync(sessionIdMapPath, 'utf8')) as Record<string, string>
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  function saveSessionIdMap(map: Record<string, string>): void {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(sessionIdMapPath, JSON.stringify(map, null, 2) + '\n', 'utf8')
  }

  function persistSessionId(accountId: string, dshSessionId: string): void {
    const map = loadSessionIdMap()
    map[accountId] = dshSessionId
    saveSessionIdMap(map)
  }

  function removePersistedSessionId(accountId: string): void {
    const map = loadSessionIdMap()
    if (accountId in map) {
      delete map[accountId]
      saveSessionIdMap(map)
    }
  }

  // -------------------------------------------------------------------------
  // Explicit project-conversation binding (Web panel selection)
  // -------------------------------------------------------------------------

  const selectedSessionIdPath = join(dataDir, 'selected-sessions.json')

  function loadSelectedSessionIds(): Record<string, string> {
    try {
      const raw = JSON.parse(readFileSync(selectedSessionIdPath, 'utf8')) as Record<string, string>
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  function saveSelectedSessionIds(map: Record<string, string>): void {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(selectedSessionIdPath, JSON.stringify(map, null, 2) + '\n', 'utf8')
  }

  function persistSelectedSessionId(accountId: string, dshSessionId: string): void {
    validateAccountId(accountId)
    const map = loadSelectedSessionIds()
    map[accountId] = dshSessionId
    saveSelectedSessionIds(map)
  }

  function removeSelectedSessionId(accountId: string): void {
    const map = loadSelectedSessionIds()
    if (accountId in map) {
      delete map[accountId]
      saveSelectedSessionIds(map)
    }
  }

  const selectedSessionIds = new Map<string, string>(Object.entries(loadSelectedSessionIds()))

  function newDshSessionId(accountId: string): string {
    return `wb-${accountId}-${Date.now()}-${randomBytes(4).toString('hex')}`
  }

  // -------------------------------------------------------------------------
  // Agent management
  // -------------------------------------------------------------------------

  async function ensureAgent(accountId: string, input?: { cwd?: string; model?: string }): Promise<AgentHandle> {
    // If the model just selected a project from inside a WeChat turn, finish
    // tearing down the old bridge agent before accepting the next message.
    if (pendingProjectSwitches.has(accountId)) {
      pendingProjectSwitches.delete(accountId)
      if (agents.has(accountId)) {
        await disposeAgent(accountId, { preserveSelection: true })
      }
    }

    const existing = agents.get(accountId)
    if (existing) return existing

    const pending = creating.get(accountId)
    if (pending) return pending

    // Programmatic agents do not inherit agentDefaultModel automatically, so we
    // resolve the deployment's default model selection explicitly.
    const task = (async () => {
      const selection = ctx.agentDefaultModel?.currentSelection()
      const provider = config.provider || selection?.provider
      const model = input?.model || config.model || selection?.model
      const agentOptions = {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      }

      // Resume the persisted DSH session when possible; create a fresh one only
      // when there is no mapping, the old log is gone/corrupt, or the requested
      // workspace differs from the persisted session's cwd (unless the user
      // explicitly bound the bridge to a project conversation).
      const selectedSessionId = selectedSessionIds.get(accountId)
      let dshSessionId = sessionIds.get(accountId)
      let handle: AgentHandle | undefined
      let resumed = false
      let isSelected = false
      let selectedCwd: string | undefined

      if (!dshSessionId) dshSessionId = selectedSessionId
      if (!dshSessionId) {
        const sessionMap = loadSessionIdMap()
        dshSessionId = sessionMap[accountId] || undefined
      }
      isSelected = !!selectedSessionId && dshSessionId === selectedSessionId

      if (dshSessionId) {
        try {
          const candidate = await ctx.agents.resume({
            resumeSessionId: SessionId(dshSessionId),
            agentOptions,
          })
          const persistedCwd = candidate.agent.session.header.cwd
          selectedCwd = persistedCwd || undefined
          const cwdMismatch = input?.cwd && persistedCwd && resolve(input.cwd) !== resolve(persistedCwd)
          if (cwdMismatch && !isSelected) {
            debugLog('resume cwd mismatch, create new', {
              accountId,
              dshSessionId,
              requested: resolve(input.cwd!),
              persisted: resolve(persistedCwd),
            })
            await candidate.dispose()
            handle = undefined
          } else {
            handle = candidate
            resumed = true
          }
        } catch (err) {
          debugLog('resume failed, create new', {
            accountId,
            dshSessionId,
            error: err instanceof Error ? err.message : String(err),
          })
          handle = undefined
        }
      }

      if (!handle) {
        if (isSelected) {
          debugLog('selected project session resume failed, clearing binding', {
            accountId,
            dshSessionId,
          })
          selectedSessionIds.delete(accountId)
          removeSelectedSessionId(accountId)
          isSelected = false
        }
        dshSessionId = newDshSessionId(accountId)
        debugLog('ensureAgent create', { accountId, dshSessionId, provider, model, selection, resumed: false, selected: false })
        handle = await ctx.agents.create({
          sessionId: SessionId(dshSessionId),
          meta: input?.cwd ? { cwd: resolve(input.cwd) } : undefined,
          agentOptions,
        })
      } else {
        debugLog('ensureAgent resume', { accountId, dshSessionId, provider, model, selection, resumed: true, selected: isSelected })
      }

      const finalSessionId = dshSessionId!
      sessionIds.set(accountId, finalSessionId)
      persistSessionId(accountId, finalSessionId)
      if (isSelected) {
        persistSelectedSessionId(accountId, finalSessionId)
      } else if (selectedSessionIds.has(accountId)) {
        selectedSessionIds.delete(accountId)
        removeSelectedSessionId(accountId)
      }
      agents.set(accountId, handle)
      activeSessionIds.add(finalSessionId)
      debugLog('agent ready', { accountId, dshSessionId: finalSessionId, provider, model, selection, resumed, selected: isSelected })
      if (isSelected && selectedCwd) {
        await attachSessionToWorkspace(finalSessionId, selectedCwd)
      } else if (input?.cwd) {
        await attachSessionToWorkspace(finalSessionId, resolve(input.cwd))
      }
      return handle
    })()

    creating.set(accountId, task)
    try {
      return await task
    } finally {
      creating.delete(accountId)
    }
  }

  async function disposeAgent(accountId: string, options?: { preserveSelection?: boolean }): Promise<void> {
    const handle = agents.get(accountId)
    const dshSessionId = sessionIds.get(accountId)
    if (dshSessionId) activeSessionIds.delete(dshSessionId)
    sessionIds.delete(accountId)
    agents.delete(accountId)
    removePersistedSessionId(accountId)
    if (!options?.preserveSelection && selectedSessionIds.has(accountId)) {
      selectedSessionIds.delete(accountId)
      removeSelectedSessionId(accountId)
    }
    if (handle) await handle.dispose()
    closeStreams(accountId)
  }

  /** Register the DSH session under a dedicated workspace so it doesn't stay Ungrouped. */
  async function attachSessionToWorkspace(dshSessionId: string, cwd: string): Promise<void> {
    const registry = ctx.get('workspaceRegistry') as {
      resolveByPath(path: string): Promise<{ attachSession(id: SessionId): Promise<void> } | undefined>
      create(path: string, title?: string): Promise<{ attachSession(id: SessionId): Promise<void> }>
    } | undefined
    if (!registry) return
    try {
      let ws = await registry.resolveByPath(cwd)
      if (!ws) ws = await registry.create(cwd, '微信桥接')
      await ws.attachSession(SessionId(dshSessionId))
      debugLog('workspace attached', { dshSessionId, cwd })
    } catch (err) {
      debugLog('workspace attach failed', {
        dshSessionId,
        cwd,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // -------------------------------------------------------------------------
  // Project conversation selection (Web panel)
  // -------------------------------------------------------------------------

  function latestAccountId(): string | undefined {
    try {
      const accountsDir = join(dataDir, 'accounts')
      const files = readdirSync(accountsDir).filter((file) => file.endsWith('.json'))
      if (files.length === 0) return undefined
      let latestFile = files[0]
      let latestMtime = 0
      for (const file of files) {
        const stat = statSync(join(accountsDir, file))
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs
          latestFile = file
        }
      }
      return latestFile.replace(/\.json$/, '')
    } catch {
      return undefined
    }
  }

  async function listProjectSessions(): Promise<ProjectSessionItem[]> {
    const registry = ctx.get('workspaceRegistry') as
      | { list(): Array<{ id: string; path: string; title: string; sessionIds: readonly unknown[]; createdAt: string }> }
      | undefined
    if (!registry?.list) return []

    const sessionsService = ctx.get('sessions') as
      | { list(): Array<{ id: unknown; header: { id?: unknown; cwd?: string; createdAt?: string } }> }
      | undefined
    const persistence = ctx.get('sessionPersistence') as
      | { listSnapshots?: () => Promise<Array<{ header: { id: unknown; cwd?: string; createdAt?: string } }>> }
      | undefined

    const headerById = new Map<string, { cwd?: string; createdAt?: string }>()
    const liveIds = new Set<string>()

    for (const session of sessionsService?.list() ?? []) {
      const id = String(session.id ?? session.header.id)
      if (!id) continue
      liveIds.add(id)
      headerById.set(id, {
        cwd: session.header.cwd,
        createdAt: session.header.createdAt,
      })
    }

    if (persistence?.listSnapshots) {
      try {
        for (const snap of await persistence.listSnapshots()) {
          const id = String(snap.header.id)
          if (!id) continue
          if (!headerById.has(id)) {
            headerById.set(id, {
              cwd: snap.header.cwd,
              createdAt: snap.header.createdAt,
            })
          }
        }
      } catch (err) {
        debugLog('listProjectSessions snapshots failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }

    const items: ProjectSessionItem[] = []
    for (const ws of registry.list()) {
      for (const sid of ws.sessionIds) {
        const sessionId = String(sid)
        const header = headerById.get(sessionId)
        items.push({
          sessionId,
          workspaceId: ws.id,
          workspaceTitle: ws.title,
          path: ws.path,
          cwd: header?.cwd || ws.path,
          createdAt: header?.createdAt || ws.createdAt,
          live: liveIds.has(sessionId),
        })
      }
    }
    return items
  }

  async function selectedProjectPayload(accountId?: string): Promise<Record<string, unknown> | null> {
    const target = accountId || latestAccountId()
    if (!target) return null
    const selectedId = selectedSessionIds.get(target)
    if (!selectedId) return null
    const items = await listProjectSessions()
    const item = items.find((candidate) => candidate.sessionId === selectedId)
    if (!item) return null
    return {
      sessionId: selectedId,
      workspaceId: item.workspaceId,
      workspaceTitle: item.workspaceTitle,
      path: item.path,
    }
  }

  function accountIdForAgent(agent: { session?: { id?: unknown } } | undefined): string | undefined {
    if (!agent?.session?.id) return undefined
    const sid = String(agent.session.id)
    for (const [accountId, dshSessionId] of sessionIds) {
      if (dshSessionId === sid) return accountId
    }
    return undefined
  }

  async function selectProjectFromAgent(agent: { session?: { id?: unknown } } | undefined, sessionId: string): Promise<Record<string, unknown>> {
    const accountId = accountIdForAgent(agent)
    if (!accountId) {
      return { ok: false, error: '当前不是微信桥接会话，无法切换项目。' }
    }
    const items = await listProjectSessions()
    const item = items.find((candidate) => candidate.sessionId === sessionId)
    if (!item) {
      return { ok: false, error: '未找到该项目会话，请先使用 wechat_bridge_list_projects 查看可绑定项目。' }
    }

    const currentDshSessionId = sessionIds.get(accountId)
    if (sessionId === currentDshSessionId) {
      return {
        ok: true,
        accountId,
        selectedSessionId: sessionId,
        project: item,
        message: `已经在项目 ${item.workspaceTitle} 中。`,
      }
    }

    const sessionsService = ctx.get('sessions') as { get(id: unknown): unknown } | undefined
    if (sessionsService?.get(SessionId(sessionId))) {
      return { ok: false, error: '该项目会话当前正在 DSH 中打开，请先在 DSH 中关闭该会话后再进入。' }
    }

    selectedSessionIds.set(accountId, sessionId)
    persistSelectedSessionId(accountId, sessionId)
    resetBridgeAccountSession(accountId, item.path)
    pendingProjectSwitches.add(accountId)

    return {
      ok: true,
      accountId,
      selectedSessionId: sessionId,
      project: item,
      message: `已进入项目 ${item.workspaceTitle}（${item.path}），后续对话会记录到这个项目。`,
    }
  }

  function readBridgeAccountSession(accountId: string): Record<string, unknown> {
    validateAccountId(accountId)
    return loadJson<Record<string, unknown>>(join(dataDir, 'sessions', `${accountId}.json`), {})
  }

  function writeBridgeAccountSession(accountId: string, session: Record<string, unknown>): void {
    validateAccountId(accountId)
    saveJson(join(dataDir, 'sessions', `${accountId}.json`), session)
  }

  function resetBridgeAccountSession(accountId: string, cwd: string): void {
    const session = readBridgeAccountSession(accountId)
    session.workingDirectory = cwd
    session.state = 'idle'
    session.chatHistory = []
    writeBridgeAccountSession(accountId, session)
  }

  async function selectProjectSession(dshSessionId: string, accountId?: string): Promise<Record<string, unknown>> {
    const target = accountId || latestAccountId()
    if (!target) return { ok: false, error: '没有已绑定的微信账号，请先扫码绑定。' }
    const items = await listProjectSessions()
    const item = items.find((candidate) => candidate.sessionId === dshSessionId)
    if (!item) return { ok: false, error: '指定的会话不存在或不属于任何项目。' }

    // If the user is re-selecting the conversation the bridge already owns,
    // treat it as a no-op instead of disposing the live agent.
    const currentDshSessionId = sessionIds.get(target)
    if (dshSessionId === currentDshSessionId) {
      return {
        ok: true,
        accountId: target,
        selectedSessionId: dshSessionId,
        project: item,
        daemon: '已经绑定到该项目会话。',
      }
    }

    // A live DSH session can only be owned by one agent loop. If the selected
    // conversation is currently open in the DSH UI, refuse before touching the
    // current bridge agent instead of silently falling back on the next message.
    const sessionsService = ctx.get('sessions') as { get(id: unknown): unknown } | undefined
    if (sessionsService?.get(SessionId(dshSessionId))) {
      return { ok: false, error: '该会话当前正在 DSH 中打开，请先在 DSH 中关闭该会话后再绑定。' }
    }

    // Drop the current bridge-owned agent so the next message resumes the
    // selected project conversation instead of the previous bridge session.
    if (agents.has(target) || sessionIds.has(target)) {
      await disposeAgent(target)
    }

    selectedSessionIds.set(target, dshSessionId)
    persistSelectedSessionId(target, dshSessionId)
    resetBridgeAccountSession(target, item.path)

    const daemonResult = daemonRunning() ? await restartDaemon() : { ok: true, message: '守护进程未运行，绑定将在下次启动时生效。' }
    return {
      ok: true,
      accountId: target,
      selectedSessionId: dshSessionId,
      project: item,
      daemon: daemonResult.message,
    }
  }

  async function detachProjectSession(accountId?: string): Promise<Record<string, unknown>> {
    const target = accountId || latestAccountId()
    if (!target) return { ok: false, error: '没有已绑定的微信账号。' }
    await disposeAgent(target)
    const config = readBridgeConfig()
    resetBridgeAccountSession(target, config.workingDirectory)
    const daemonResult = daemonRunning() ? await restartDaemon() : { ok: true, message: '守护进程未运行，解除绑定将在下次启动时生效。' }
    return { ok: true, accountId: target, daemon: daemonResult.message }
  }

  // -------------------------------------------------------------------------
  // SSE broadcast
  // -------------------------------------------------------------------------

  function broadcast(sessionId: string, event: StreamEvent): void {
    const clients = streamClients.get(sessionId)
    if (!clients || clients.size === 0) return
    const payload = `data: ${JSON.stringify({ ...event, sessionId })}\n\n`
    for (const res of [...clients]) {
      try {
        res.write(payload)
      } catch {
        // Client may have gone away; cleanup below.
      }
    }
    if (event.type === 'done' || event.type === 'error') {
      closeStreams(sessionId)
    }
  }

  function closeStreams(sessionId: string): void {
    const clients = streamClients.get(sessionId)
    if (!clients) return
    for (const res of [...clients]) {
      try {
        res.end()
      } catch {
        // ignore
      }
    }
    streamClients.delete(sessionId)
  }

  // Subscribe to every session event and forward assistant chunks to the
  // bridge daemon. Only sessions created by this plugin are forwarded.
  ctx.on('session/event', (session: { id: unknown }, event: SessionEvent) => {
    const sid = String(session.id)
    if (!activeSessionIds.has(sid)) return
    const accountId = [...sessionIds.entries()].find(([, v]) => v === sid)?.[0]
    if (!accountId) return

    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk as { type?: string; text?: string } | undefined
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        broadcast(accountId, { type: 'chunk', text: chunk.text })
      }
    } else if (event.type === 'turn/end') {
      debugLog('session turn/end', { accountId, sessionId: sid, reason: event.data.reason })
      broadcast(accountId, { type: 'done', turn: event.data.turn, message: 'turn ended' })
      if (pendingProjectSwitches.has(accountId)) {
        pendingProjectSwitches.delete(accountId)
        void disposeAgent(accountId, { preserveSelection: true }).catch((err) => {
          debugLog('pending project switch dispose failed', {
            accountId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
    }
  })

  // -------------------------------------------------------------------------
  // Internal HTTP server (daemon-facing, token protected)
  // -------------------------------------------------------------------------

  function isAuthorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization || ''
    return header === `Bearer ${token}`
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  async function readBody(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    if (chunks.length === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  async function handleInternal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)

    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/status') {
        sendJson(res, 200, await statusPayload())
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/projects') {
        sendJson(res, 200, { ok: true, items: await listProjectSessions() })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/projects/select') {
        const body = await readBody(req)
        const sessionId = String(body.sessionId || '')
        const result = await selectProjectSession(sessionId)
        sendJson(res, result.ok ? 200 : 400, result)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/projects/detach') {
        const result = await detachProjectSession()
        sendJson(res, result.ok ? 200 : 400, result)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/prompt') {
        const body = await readBody(req)
        const sessionId: string = String(body.sessionId || 'default')
        const handle = await ensureAgent(sessionId, { cwd: body.cwd, model: body.model })
        const text = String(body.text || '').trim()
        if (!text) {
          sendJson(res, 400, { ok: false, error: 'text is required' })
          return
        }
        handle.agent.followup(createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text }],
        }))
        sendJson(res, 200, { accepted: true, sessionId })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/stop') {
        const body = await readBody(req)
        const sessionId = String(body.sessionId || 'default')
        const handle = agents.get(sessionId)
        if (handle) {
          handle.agent.cancel({ kind: 'user' })
        }
        sendJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/clear') {
        const body = await readBody(req)
        const sessionId = String(body.sessionId || 'default')
        await disposeAgent(sessionId)
        sendJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/stream') {
        const sessionId = url.searchParams.get('sessionId') || 'default'
        if (!agents.has(sessionId)) {
          sendJson(res, 404, { ok: false, error: 'session not active' })
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write('retry: 3000\n\n')
        let set = streamClients.get(sessionId)
        if (!set) {
          set = new Set()
          streamClients.set(sessionId, set)
        }
        set.add(res)
        req.on('close', () => {
          set?.delete(res)
          if (set?.size === 0) streamClients.delete(sessionId)
        })
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 400, { ok: false, error: message })
    }
  }

  // -------------------------------------------------------------------------
  // Daemon process management (cross-platform)
  // -------------------------------------------------------------------------

  function bridgeScript(): string {
    return join(dirname(fileURLToPath(import.meta.url)), 'bridge', 'main.js')
  }

  function readPid(): number | null {
    try {
      const raw = readFileSync(pidPath, 'utf8').trim()
      const pid = Number(raw)
      return Number.isInteger(pid) && pid > 0 ? pid : null
    } catch {
      return null
    }
  }

  function isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  function daemonRunning(): boolean {
    if (bridgeChild && bridgeChild.pid !== undefined) {
      try {
        if (bridgeChild.exitCode === null) return true
      } catch {
        // fall through
      }
    }
    const pid = readPid()
    return pid !== null && isPidAlive(pid)
  }

  function daemonPid(): number | undefined {
    if (bridgeChild && bridgeChild.pid !== undefined && bridgeChild.exitCode === null) {
      return bridgeChild.pid
    }
    return readPid() ?? undefined
  }

  async function startDaemon(): Promise<{ ok: boolean; message: string }> {
    if (daemonRunning()) {
      return { ok: true, message: `已运行 (PID: ${daemonPid()})` }
    }

    const script = bridgeScript()
    if (!existsSync(script)) {
      return { ok: false, message: `桥接脚本不存在: ${script}（请先 build 插件）` }
    }

    const logFd = await import('node:fs').then(fs => fs.openSync(daemonLogPath, 'a'))
    const child = spawn(process.execPath, [script, 'start'], {
      cwd: dirname(script),
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_BRIDGE_DATA_DIR: dataDir,
        DSH_BRIDGE_API_BASE: `http://127.0.0.1:${internalPort}`,
        DSH_BRIDGE_API_TOKEN: token,
      },
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    })

    bridgeChild = child
    writeFileSync(pidPath, String(child.pid || ''), 'utf8')

    child.on('exit', (code) => {
      try {
        if (bridgeChild === child) bridgeChild = undefined
        const pid = readPid()
        if (pid === child.pid) unlinkSync(pidPath)
      } catch {
        // ignore
      }
      ctx.logger?.info?.('[dsh-wechat-bridge] daemon exited', { code })
    })

    // Give the daemon a moment to fail early (missing account etc.).
    await new Promise(r => setTimeout(r, 300))
    if (child.exitCode !== null) {
      return { ok: false, message: `守护进程启动失败 (exit ${child.exitCode})，请查看日志` }
    }

    bridgeStartedAt = Date.now()
    return { ok: true, message: `已启动 (PID: ${child.pid})` }
  }

  async function stopDaemon(): Promise<{ ok: boolean; message: string }> {
    const pid = daemonPid()
    if (bridgeChild && bridgeChild.pid !== undefined && bridgeChild.exitCode === null) {
      bridgeChild.kill()
      await new Promise(r => setTimeout(r, 500))
      if (bridgeChild.exitCode === null) {
        bridgeChild.kill('SIGKILL')
      }
    } else if (pid) {
      try {
        process.kill(pid)
      } catch {
        // already gone
      }
    }
    try {
      unlinkSync(pidPath)
    } catch {
      // ignore
    }
    bridgeChild = undefined
    return { ok: true, message: '已停止' }
  }

  async function restartDaemon(): Promise<{ ok: boolean; message: string }> {
    await stopDaemon()
    await new Promise(r => setTimeout(r, 300))
    return startDaemon()
  }

  function bridgeConfigPath(): string {
    return join(dataDir, 'config.json')
  }

  function readBridgeConfig(): { workingDirectory: string; model?: string; systemPrompt?: string } {
    try {
      const raw = JSON.parse(readFileSync(bridgeConfigPath(), 'utf8')) as {
        workingDirectory?: string
        model?: string
        systemPrompt?: string
      }
      return {
        workingDirectory: raw.workingDirectory || join(homedir(), 'Documents', 'DSH'),
        model: raw.model,
        systemPrompt: raw.systemPrompt,
      }
    } catch {
      return {
        workingDirectory: join(homedir(), 'Documents', 'DSH'),
      }
    }
  }

  function saveBridgeConfig(config: { workingDirectory: string; model?: string; systemPrompt?: string }): void {
    mkdirSync(dataDir, { recursive: true })
    const data: Record<string, string> = {
      workingDirectory: config.workingDirectory,
    }
    if (config.model) data.model = config.model
    if (config.systemPrompt) data.systemPrompt = config.systemPrompt
    writeFileSync(bridgeConfigPath(), JSON.stringify(data, null, 2) + '\n', 'utf8')
    if (process.platform !== 'win32') {
      chmodSync(bridgeConfigPath(), 0o600)
    }
  }

  async function startSetup(workingDirectory?: string): Promise<Record<string, unknown>> {
    const dir = (workingDirectory?.trim() || readBridgeConfig().workingDirectory || join(homedir(), 'Documents', 'DSH')).replace(/^~/, homedir())
    const { qrcodeUrl, qrcodeId } = await startQrLogin()
    const QRCode = await import('qrcode')
    const qrcodeDataUrl = await QRCode.toDataURL(qrcodeUrl, {
      width: 320,
      margin: 2,
    })
    pendingSetup = { qrcodeId, workingDirectory: dir }
    return {
      ok: true,
      qrcodeId,
      qrcodeUrl,
      qrcodeDataUrl,
      workingDirectory: dir,
    }
  }

  async function checkSetupStatus(qrcodeId: string): Promise<Record<string, unknown>> {
    if (!pendingSetup || pendingSetup.qrcodeId !== qrcodeId) {
      return { ok: false, status: 'idle', message: '没有进行中的扫码绑定，请先点击“扫码绑定”。' }
    }

    const result = await checkQrStatus(qrcodeId)

    if (result.status === 'confirmed') {
      const config = readBridgeConfig()
      config.workingDirectory = pendingSetup.workingDirectory
      saveBridgeConfig(config)
      pendingSetup = undefined

      // A newly bound account only takes effect after the daemon reloads the
      // latest account file. Restart when running, otherwise start it so the
      // user does not have to manually restart after every re-scan.
      const daemonResult = daemonRunning() ? await restartDaemon() : await startDaemon()
      return {
        ok: true,
        status: 'confirmed',
        accountId: result.account.accountId,
        workingDirectory: config.workingDirectory,
        daemon: daemonResult.message,
      }
    }

    if (result.status === 'expired') {
      pendingSetup = undefined
      return { ok: false, status: 'expired', message: result.message }
    }

    if (result.status === 'error') {
      return { ok: false, status: 'error', message: result.message, retryable: result.retryable }
    }

    return { ok: true, status: result.status }
  }

  function readDaemonLogs(limit = 100): string {
    try {
      if (!existsSync(daemonLogPath)) return '暂无日志'
      const text = readFileSync(daemonLogPath, 'utf8')
      const lines = text.split('\n').filter(Boolean)
      return lines.slice(-limit).join('\n')
    } catch {
      return '读取日志失败'
    }
  }

  async function statusPayload(): Promise<Record<string, unknown>> {
    const accountFiles: string[] = []
    try {
      const accountsDir = join(dataDir, 'accounts')
      if (existsSync(accountsDir)) {
        for (const f of readdirSync(accountsDir)) {
          if (f.endsWith('.json')) accountFiles.push(f)
        }
      }
    } catch {
      // ignore
    }
    return {
      ok: true,
      plugin: name,
      running: daemonRunning(),
      pid: daemonPid() ?? null,
      startedAt: bridgeStartedAt ?? null,
      dataDir,
      apiBase: internalPort ? `http://127.0.0.1:${internalPort}` : null,
      workingDirectory: readBridgeConfig().workingDirectory,
      accounts: accountFiles,
      sessions: [...sessionIds.keys()],
      selectedProject: await selectedProjectPayload(),
    }
  }

  // -------------------------------------------------------------------------
  // Optional Web panel routes (same origin, no token)
  // -------------------------------------------------------------------------

  function registerWebRoutes(): (() => void)[] {
    const webServer = ctx.get('webServer') as
      | { register(route: WebRouteLike): () => void }
      | undefined
    if (!webServer) return []

    const disposers: (() => void)[] = []

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/@lanbaolu/dsh-wechat-bridge/status',
      handler: async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(await statusPayload()))
      },
    }))

    for (const action of ['start', 'stop', 'restart'] as const) {
      disposers.push(webServer.register({
        kind: 'exact',
        path: `/@lanbaolu/dsh-wechat-bridge/${action}`,
        handler: async (_req, res) => {
          const result = action === 'start' ? await startDaemon()
            : action === 'stop' ? await stopDaemon()
            : await restartDaemon()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        },
      }))
    }

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/@lanbaolu/dsh-wechat-bridge/logs',
      handler: async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(readDaemonLogs(200))
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/@lanbaolu/dsh-wechat-bridge/projects',
      handler: async (_req, res) => {
        const result = await listProjectSessions()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, items: result }))
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/@lanbaolu/dsh-wechat-bridge/projects/select',
      handler: async (req, res) => {
        try {
          const body = await readBody(req)
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          const accountId = typeof body.accountId === 'string' && body.accountId ? body.accountId : undefined
          const result = await selectProjectSession(sessionId, accountId)
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: message }))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/@lanbaolu/dsh-wechat-bridge/projects/detach',
      handler: async (req, res) => {
        try {
          const body = await readBody(req).catch(() => ({}))
          const accountId = body && typeof body.accountId === 'string' && body.accountId ? body.accountId : undefined
          const result = await detachProjectSession(accountId)
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: message }))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/@lanbaolu/dsh-wechat-bridge/setup/start',
      handler: async (req, res) => {
        let workingDirectory: string | undefined
        try {
          const body = await readBody(req)
          workingDirectory = typeof body.workingDirectory === 'string' ? body.workingDirectory : undefined
        } catch {
          // body optional
        }
        const result = await startSetup(workingDirectory)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/@lanbaolu/dsh-wechat-bridge/setup/status',
      handler: async (req, res) => {
        const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
        const qrcodeId = url.searchParams.get('qrcodeId') || ''
        const result = await checkSetupStatus(qrcodeId)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      },
    }))

    return disposers
  }

  // -------------------------------------------------------------------------
  // Model-facing tools
  // -------------------------------------------------------------------------

  function registerTools(): void {
    const simpleOutput = {
      schema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' as const, required: true as const },
          message: { type: 'string' as const, required: true as const },
        },
      },
      render: (_args: unknown, value: { ok: boolean; message: string }) => [{
        type: 'text' as const,
        text: value.message,
      }],
    }

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_status',
      description: '查看 DSH 微信桥接状态：守护进程是否运行、PID、数据目录、已绑定账号与活跃会话。',
      parameters: {},
      output: simpleOutput,
      execute: async () => {
        const p = await statusPayload()
        return {
          ok: true,
          message: `运行中: ${p.running}\nPID: ${p.pid ?? '无'}\n数据目录: ${p.dataDir}\n账号: ${(p.accounts as string[]).join(', ') || '无'}\n活跃会话: ${(p.sessions as string[]).join(', ') || '无'}`,
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_list_projects',
      description: '列出 DSH 中可进入/可绑定的项目会话（含项目名、路径、会话 ID）。当用户询问“有哪些项目”“看看我有什么项目”“我要看下项目”“我在哪个项目”“想继续某个项目”“有个任务想做”等意图，或用户描述内容可能对应某个项目时，都应调用此工具查看项目，不要要求用户使用固定句式。',
      parameters: {},
      output: {
        schema: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' as const, required: true as const },
            message: { type: 'string' as const, required: true as const },
            projects: {
              type: 'array' as const,
              required: true as const,
              items: {
                type: 'object' as const,
                additionalProperties: false,
                properties: {
                  sessionId: { type: 'string' as const, required: true as const },
                  workspaceTitle: { type: 'string' as const, required: true as const },
                  path: { type: 'string' as const, required: true as const },
                  live: { type: 'boolean' as const, required: true as const },
                },
              },
            },
          },
        },
        render: (_args: unknown, value: { projects: Array<{ sessionId: string; workspaceTitle: string; path: string; live: boolean }> }) => [{
          type: 'text' as const,
          text: value.projects.length === 0
            ? '当前没有可绑定的项目会话。'
            : `📁 可进入的项目会话（${value.projects.length} 个）：\n` + value.projects.map((p, i) => `${i + 1}. ${p.workspaceTitle} · ${p.path} · ${p.sessionId.slice(-8)}`).join('\n'),
        }],
      },
      execute: async () => {
        const items = await listProjectSessions()
        return {
          ok: true,
          message: `共 ${items.length} 个项目会话`,
          projects: items.map((item) => ({
            sessionId: item.sessionId,
            workspaceTitle: item.workspaceTitle,
            path: item.path,
            live: item.live,
          })),
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_select_project',
      description: '进入一个 DSH 项目会话。微信桥接会话中，模型应先调用 wechat_bridge_list_projects 获取 sessionId，再调用本工具切换到对应项目；切换后后续微信对话会记录到该项目。支持用户自然语言模糊指代，例如“进入某某项目”“去这个项目”“继续在 XXX 里做”“我现在要做 XXX”等，模型应根据上下文/项目列表选择对应 sessionId。',
      parameters: {
        sessionId: { type: 'string', description: '要进入的项目会话 ID，来自 wechat_bridge_list_projects 返回的 sessionId。' },
      },
      output: simpleOutput,
      execute: async (args: { sessionId: string }, exec: { agent?: { session?: { id?: unknown } } }) => {
        const result = await selectProjectFromAgent(exec?.agent, args.sessionId)
        if (!result.ok) {
          throw new Error(String(result.error || '进入项目失败'))
        }
        return {
          ok: true,
          message: String(result.message || '已进入项目。'),
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_start',
      description: '启动 DSH 微信桥接守护进程。需要先完成微信扫码绑定（wechat_bridge_setup 或 node lib/bridge/main.js setup）。',
      parameters: {},
      output: simpleOutput,
      execute: startDaemon,
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_stop',
      description: '停止 DSH 微信桥接守护进程。',
      parameters: {},
      output: simpleOutput,
      execute: stopDaemon,
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_restart',
      description: '重启 DSH 微信桥接守护进程（更新配置或卡死后使用）。',
      parameters: {},
      output: simpleOutput,
      execute: restartDaemon,
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_logs',
      description: '读取 DSH 微信桥接守护进程最近日志（默认 100 行，可通过参数调整）。',
      parameters: {
        lines: { type: 'number', description: '读取最近多少行日志，默认 100。' },
      },
      output: {
        schema: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' as const, required: true as const },
            logs: { type: 'string' as const, required: true as const },
          },
        },
        render: (_args: unknown, value: { ok: boolean; logs: string }) => [{
          type: 'text',
          text: value.logs || '（空日志）',
        }],
      },
      execute: async (args: { lines?: number }) => ({
        ok: true,
        logs: readDaemonLogs(args.lines && args.lines > 0 ? args.lines : 100),
      }),
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_setup',
      description: '显示 DSH 微信桥接的扫码绑定方式：在终端运行 node <bridgeScript> setup。该命令会生成二维码并用系统默认应用打开。',
      parameters: {},
      output: {
        schema: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' as const, required: true as const },
            command: { type: 'string' as const, required: true as const },
          },
        },
        render: (_args: unknown, value: { ok: boolean; command: string }) => [{
          type: 'text',
          text: `请在 DSH 所在机器终端执行：\n${value.command}`,
        }],
      },
      execute: async () => ({
        ok: true,
        command: `node "${bridgeScript()}" setup`,
      }),
    }))
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  ctx.effect(() => {
    const server = createServer((req, res) => {
      handleInternal(req, res).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        sendJson(res, 500, { ok: false, error: message })
      })
    })

    server.listen(config.port, config.host, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        internalPort = address.port
      }
      ctx.logger?.info?.('[dsh-wechat-bridge] internal API listening', {
        host: config.host,
        port: internalPort,
      })
      if (config.autoStart) {
        startDaemon().then(result => {
          ctx.logger?.info?.('[dsh-wechat-bridge] autoStart', result)
        }).catch(err => {
          ctx.logger?.warn?.('[dsh-wechat-bridge] autoStart failed', { error: String(err) })
        })
      }
    })
    internalServer = server

    registerTools()
    const webDisposers = registerWebRoutes()

    // Watchdog: after sleep/wake or an unexpected daemon exit, automatically
    // bring the bridge back instead of requiring the user to click Start.
    let healthTimer: ReturnType<typeof setInterval> | undefined
    if (config.autoStart) {
      healthTimer = setInterval(() => {
        if (daemonRunning()) return
        startDaemon().then(result => {
          ctx.logger?.info?.('[dsh-wechat-bridge] watchdog auto-start', result)
        }).catch(err => {
          ctx.logger?.warn?.('[dsh-wechat-bridge] watchdog auto-start failed', { error: String(err) })
        })
      }, 15_000)
      healthTimer.unref?.()
    }

    return () => {
      if (healthTimer) clearInterval(healthTimer)
      for (const dispose of webDisposers) dispose()
      for (const handle of agents.values()) {
        void handle.dispose()
      }
      agents.clear()
      activeSessionIds.clear()
      streamClients.clear()
      if (bridgeChild && bridgeChild.exitCode === null) {
        bridgeChild.kill()
      }
      try {
        server.close()
      } catch {
        // ignore
      }
    }
  })
}
