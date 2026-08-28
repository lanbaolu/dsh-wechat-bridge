import type * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'

const API_BASE = '/@lanbaolu/dsh-wechat-bridge'

const panelStyle = {
  padding: '14px 16px',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--text-1, #1f2328)',
  background: 'var(--surface-2, rgba(127,127,127,.06))',
  border: '1px solid var(--border-color, rgba(127,127,127,.18))',
  borderRadius: 10,
  margin: '8px 0',
  // DSH 宿主不使用 --text-1/--surface-2 等通用变量名（实际变量体系为 --dsw-alias-*），
  // 导致深色主题下文字永远 fallback 到黑色 #1f2328，几乎不可读。
  // 在面板根元素上把用到的变量映射到宿主真实变量，深浅主题自动跟随。
  // @types/react 18 的 CSSProperties 不含 CSS 自定义属性键，故用交叉类型断言。
  '--text-1': 'var(--dsw-alias-label-primary, #1f2328)',
  '--surface-2': 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,.06))',
  '--surface-3': 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.04))',
  '--border-color': 'var(--dsw-alias-border-l2, rgba(127,127,127,.18))',
  '--button-bg': 'var(--dsw-alias-bg-layer-1, #fff)',
} as React.CSSProperties &
  Record<'--text-1' | '--surface-2' | '--surface-3' | '--border-color' | '--button-bg', string>

const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  marginBottom: 8,
}

const outputStyle: React.CSSProperties = {
  margin: '4px 0 8px',
  padding: '8px 10px',
  background: 'var(--surface-3, rgba(0,0,0,.04))',
  border: '1px solid var(--border-color, rgba(127,127,127,.15))',
  borderRadius: 6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  maxHeight: 360,
  overflow: 'auto',
}

const buttonRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  alignItems: 'center',
}

const buttonStyle: React.CSSProperties = {
  padding: '4px 10px',
  border: '1px solid var(--border-color, rgba(127,127,127,.4))',
  borderRadius: 6,
  background: 'var(--button-bg, #fff)',
  color: 'var(--text-1, inherit)',
  cursor: 'pointer',
  fontSize: 12,
}

const inputStyle: React.CSSProperties = {
  padding: '4px 8px',
  border: '1px solid var(--border-color, rgba(127,127,127,.4))',
  borderRadius: 6,
  background: 'var(--surface-3, rgba(127,127,127,.06))',
  color: 'var(--text-1, inherit)',
  fontSize: 12,
  minWidth: 220,
}

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  minWidth: 320,
  maxWidth: '100%',
}

const hintStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  opacity: 0.7,
}

type SetupPhase = 'idle' | 'starting' | 'qr' | 'confirmed' | 'error'

interface ProjectSessionItem {
  sessionId: string
  workspaceId: string
  workspaceTitle: string
  path: string
  cwd?: string
  createdAt: string
  live: boolean
}

interface SelectedProjectInfo {
  sessionId: string
  workspaceId: string
  workspaceTitle: string
  path: string
}

interface NotifyStatus {
  dailySent: number
  dailyLimit: number
  hourlySent: number
  hourlyLimit: number
  pendingCount: number
  queueCapacity: number
}

interface TrustedUser {
  userId: string
  addedAt: string
  by: 'owner' | 'bootstrap' | 'restore'
  lastSeenAt?: number
  note?: string
}

interface TrustInfo {
  mode: 'owner-only' | 'bootstrap' | 'manual'
  bootstrapConsumed: boolean
  owner: string
  notifyRejected: boolean
  trusted: TrustedUser[]
}

const TRUST_MODE_LABELS: Record<TrustInfo['mode'], string> = {
  'owner-only': '仅本机主人（默认）',
  bootstrap: '首位陌生人自动入集（一次性）',
  manual: '仅手动添加的人',
}

/** 超时安抚配置的面板编辑态（分钟用字符串便于输入，保存时转换）。 */
interface CalmUiState {
  enabled: boolean
  silenceMin: string
  intervalMin: string
  maxCount: string
  messages: string
}

const CALM_DEFAULTS: CalmUiState = { enabled: true, silenceMin: '5', intervalMin: '5', maxCount: '0', messages: '' }

function calmFromConfig(calm?: { enabled?: boolean; silenceMs?: number; intervalMs?: number; maxCount?: number; messages?: string[] }): CalmUiState {
  return {
    enabled: calm?.enabled !== false,
    silenceMin: calm?.silenceMs && calm.silenceMs > 0 ? String(Math.round(calm.silenceMs / 60000)) : '5',
    intervalMin: calm?.intervalMs && calm.intervalMs > 0 ? String(Math.round(calm.intervalMs / 60000)) : '5',
    maxCount: calm?.maxCount !== undefined ? String(calm.maxCount) : '0',
    messages: calm?.messages?.length ? calm.messages.join('\n') : '',
  }
}

function calmToConfig(ui: CalmUiState): { enabled: boolean; silenceMs?: number; intervalMs?: number; maxCount?: number; messages?: string[] } {
  const toMin = (v: string): number | undefined => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.round(n * 60000) : undefined
  }
  const maxCount = Number(ui.maxCount)
  const messages = ui.messages.split('\n').map((s) => s.trim()).filter(Boolean)
  return {
    enabled: ui.enabled,
    silenceMs: toMin(ui.silenceMin),
    intervalMs: toMin(ui.intervalMin),
    maxCount: Number.isFinite(maxCount) && maxCount >= 0 ? Math.round(maxCount) : undefined,
    messages: messages.length > 0 ? messages : undefined,
  }
}

function formatTime(ms?: number): string {
  if (!ms) return '从未活跃'
  try {
    return new Date(ms).toLocaleString('zh-CN')
  } catch {
    return '未知'
  }
}

export function WechatBridgePanel(_props: SettingsSectionOwnerProps): React.JSX.Element {
  const [output, setOutput] = useState('加载中…')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [workingDir, setWorkingDir] = useState('')
  const [setupPhase, setSetupPhase] = useState<SetupPhase>('idle')
  const [qrcodeDataUrl, setQrcodeDataUrl] = useState('')
  const [qrcodeId, setQrcodeId] = useState('')
  const [setupError, setSetupError] = useState('')
  const [boundAccountId, setBoundAccountId] = useState('')
  const [daemonMessage, setDaemonMessage] = useState('')
  const [projects, setProjects] = useState<ProjectSessionItem[]>([])
  const [projectChoice, setProjectChoice] = useState('')
  const [boundProject, setBoundProject] = useState<SelectedProjectInfo | null>(null)
  const [projectBusy, setProjectBusy] = useState(false)
  const [projectMessage, setProjectMessage] = useState('')
  const [projectError, setProjectError] = useState('')
  const [notifyStatus, setNotifyStatus] = useState<NotifyStatus | null>(null)
  const [calm, setCalm] = useState<CalmUiState>(CALM_DEFAULTS)
  const [calmBusy, setCalmBusy] = useState(false)
  const [calmMessage, setCalmMessage] = useState('')
  const [calmError, setCalmError] = useState('')
  const [trust, setTrust] = useState<TrustInfo | null>(null)
  const [trustBusy, setTrustBusy] = useState(false)
  const [trustMessage, setTrustMessage] = useState('')
  const [trustError, setTrustError] = useState('')
  const [newTrustId, setNewTrustId] = useState('')
  const [newTrustNote, setNewTrustNote] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [statusRes, projectsRes, notifyRes] = await Promise.all([
        fetch(`${API_BASE}/status`, { cache: 'no-store' }),
        fetch(`${API_BASE}/projects`, { cache: 'no-store' }),
        fetch(`${API_BASE}/notify/status`, { cache: 'no-store' }),
      ])
      if (!statusRes.ok) throw new Error(`status HTTP ${statusRes.status}`)
      if (!projectsRes.ok) throw new Error(`projects HTTP ${projectsRes.status}`)
      const data = await statusRes.json()
      const projectsData = await projectsRes.json()
      const notifyData = await notifyRes.json().catch(() => null)
      if (notifyData && typeof notifyData === 'object' && typeof (notifyData as { data?: NotifyStatus }).data?.dailyLimit === 'number') {
        setNotifyStatus((notifyData as { data: NotifyStatus }).data)
      } else if (notifyData && typeof (notifyData as NotifyStatus).dailyLimit === 'number') {
        setNotifyStatus(notifyData as NotifyStatus)
      }
      setOutput(JSON.stringify(data, null, 2))
      if (typeof data.workingDirectory === 'string') {
        setWorkingDir((prev) => prev || data.workingDirectory)
      }
      setBoundProject(data.selectedProject ?? null)
      if (Array.isArray(projectsData.items)) {
        setProjects(projectsData.items as ProjectSessionItem[])
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    // 信任集单独拉取（失败不影响主状态展示）
    try {
      const trustRes = await fetch(`${API_BASE}/trust`, { cache: 'no-store' })
      if (trustRes.ok) {
        const trustData = await trustRes.json()
        if (trustData && typeof trustData === 'object' && trustData.ok) {
          setTrust(trustData as TrustInfo)
        }
      }
    } catch {
      // ignore
    }
    // 桥接配置（超时安抚等）单独拉取，避免被初次渲染的默认值覆盖
    try {
      const cfgRes = await fetch(`${API_BASE}/config`, { cache: 'no-store' })
      if (cfgRes.ok) {
        const cfgData = await cfgRes.json()
        if (cfgData && typeof cfgData === 'object' && cfgData.ok) {
          setCalm(calmFromConfig(cfgData.calm))
        }
      }
    } catch {
      // ignore
    }
  }, [])

  async function saveCalm(): Promise<void> {
    setCalmBusy(true)
    setCalmError('')
    setCalmMessage('')
    try {
      const res = await fetch(`${API_BASE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calm: calmToConfig(calm) }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`)
      }
      setCalmMessage('已保存，下次安抚时生效（最长延迟数秒）。')
    } catch (err) {
      setCalmError(err instanceof Error ? err.message : String(err))
    } finally {
      setCalmBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function run(path: string): Promise<void> {
    setBusy(path)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/${path}`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setOutput(JSON.stringify(data, null, 2))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function showLogs(): Promise<void> {
    setBusy('logs')
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/logs`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setOutput(await res.text())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function startSetup(): Promise<void> {
    setSetupPhase('starting')
    setSetupError('')
    try {
      const res = await fetch(`${API_BASE}/setup/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDirectory: workingDir || undefined }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.message || data.error || '启动扫码绑定失败')
      setQrcodeDataUrl(data.qrcodeDataUrl)
      setQrcodeId(data.qrcodeId)
      setWorkingDir(data.workingDirectory || workingDir)
      setSetupPhase('qr')
    } catch (err) {
      setSetupPhase('error')
      setSetupError(err instanceof Error ? err.message : String(err))
    }
  }

  async function bindProject(): Promise<void> {
    if (!projectChoice) return
    setProjectBusy(true)
    setProjectError('')
    setProjectMessage('')
    try {
      const res = await fetch(`${API_BASE}/projects/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: projectChoice }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || data?.message || `HTTP ${res.status}`)
      }
      const project = data.project as SelectedProjectInfo | undefined
      setProjectMessage(`已绑定项目会话${project?.workspaceTitle ? `：${project.workspaceTitle}` : ''}${data.daemon ? `（${data.daemon}）` : ''}`)
      await refresh()
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : String(err))
    } finally {
      setProjectBusy(false)
    }
  }

  async function detachProject(): Promise<void> {
    setProjectBusy(true)
    setProjectError('')
    setProjectMessage('')
    try {
      const res = await fetch(`${API_BASE}/projects/detach`, { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || data?.message || `HTTP ${res.status}`)
      }
      setProjectMessage(`已解除项目会话绑定${data.daemon ? `（${data.daemon}）` : ''}`)
      setProjectChoice('')
      await refresh()
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : String(err))
    } finally {
      setProjectBusy(false)
    }
  }

  // ---- 信任集管理（P1-2 / M4）----

  function applyTrustResponse(data: TrustInfo & { ok?: boolean; error?: string }): void {
    if (data.ok === false) throw new Error(data.error || '操作失败')
    setTrust({
      mode: data.mode,
      bootstrapConsumed: data.bootstrapConsumed,
      owner: data.owner,
      notifyRejected: data.notifyRejected,
      trusted: Array.isArray(data.trusted) ? data.trusted : [],
    })
  }

  async function trustRequest(path: string, body: Record<string, unknown>, okMessage: string): Promise<void> {
    setTrustBusy(true)
    setTrustError('')
    setTrustMessage('')
    try {
      const res = await fetch(`${API_BASE}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`)
      }
      applyTrustResponse(data as TrustInfo & { ok?: boolean; error?: string })
      setTrustMessage(okMessage)
    } catch (err) {
      setTrustError(err instanceof Error ? err.message : String(err))
    } finally {
      setTrustBusy(false)
    }
  }

  async function addTrustedUser(): Promise<void> {
    const id = newTrustId.trim()
    if (!id) return
    await trustRequest('trust/add', { userId: id, note: newTrustNote.trim() || undefined }, `已添加：${id}`)
    setNewTrustId('')
    setNewTrustNote('')
  }

  function removeTrustedUser(userId: string): void {
    if (!window.confirm(`确认吊销 ${userId}？其后续消息将被拒绝，已有会话历史保留。`)) return
    void trustRequest('trust/remove', { userId }, `已吊销：${userId}`)
  }

  function changeTrustMode(mode: TrustInfo['mode']): void {
    void trustRequest('trust/config', { mode }, `信任模式已切换为：${TRUST_MODE_LABELS[mode]}`)
  }

  function toggleNotifyRejected(enabled: boolean): void {
    void trustRequest('trust/config', { notifyRejected: enabled }, enabled ? '已开启陌生人联系提醒' : '已关闭陌生人联系提醒')
  }

  useEffect(() => {
    if (setupPhase !== 'qr' || !qrcodeId) return

    let cancelled = false
    let timer: number | undefined

    async function poll(): Promise<void> {
      try {
        const res = await fetch(`${API_BASE}/setup/status?qrcodeId=${encodeURIComponent(qrcodeId)}`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (cancelled) return

        if (data.status === 'confirmed') {
          setSetupPhase('confirmed')
          setBoundAccountId(data.accountId || '')
          setDaemonMessage(data.daemon || '')
          void refresh()
          return
        }

        if (data.status === 'expired' || (data.status === 'error' && !data.retryable)) {
          setSetupPhase('error')
          setSetupError(data.message || '绑定失败，请重试')
          return
        }

        timer = window.setTimeout(() => void poll(), 3000)
      } catch (err) {
        if (!cancelled) {
          setSetupPhase('error')
          setSetupError(err instanceof Error ? err.message : String(err))
        }
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [setupPhase, qrcodeId, refresh])

  function cancelSetup(): void {
    setSetupPhase('idle')
    setQrcodeDataUrl('')
    setQrcodeId('')
    setSetupError('')
    setDaemonMessage('')
  }

  const actions: Array<{ label: string; run: () => void; disabled?: boolean }> = [
    { label: '刷新状态', run: () => void refresh() },
    { label: '扫码绑定', run: () => void startSetup(), disabled: setupPhase === 'starting' || setupPhase === 'qr' },
    { label: '启动', run: () => void run('start'), disabled: busy !== null },
    { label: '停止', run: () => void run('stop'), disabled: busy !== null },
    { label: '重启', run: () => void run('restart'), disabled: busy !== null },
    { label: '查看日志', run: () => void showLogs(), disabled: busy !== null },
  ]

  return (
    <div style={panelStyle} role="region" aria-label="DSH 微信桥接管理面板">
      <div style={titleStyle}>📱 DSH 微信桥接</div>

      {error && <div role="alert" style={{ color: '#e5484d', marginBottom: 8 }}>{error}</div>}

      <label style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
        DSH 工作目录
        <input
          type="text"
          value={workingDir}
          onChange={(e) => setWorkingDir(e.target.value)}
          placeholder="例如 ~/Documents/DSH"
          style={{ ...inputStyle, marginLeft: 8 }}
        />
      </label>

      <div style={{ marginBottom: 12 }}>
        <div style={{ ...titleStyle, marginBottom: 4 }}>项目对话绑定</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          {boundProject
            ? `当前绑定：${boundProject.workspaceTitle} · ${boundProject.path} · ${boundProject.sessionId.slice(-8)}`
            : '当前未绑定：微信消息使用独立桥接会话（也可选择项目对话以共享记忆）。'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
          <select
            value={projectChoice}
            onChange={(e) => setProjectChoice(e.target.value)}
            style={selectStyle}
            aria-label="选择要绑定的项目会话"
          >
            <option value="">— 选择要绑定的项目会话 —</option>
            {projects.map((project) => (
              <option key={project.sessionId} value={project.sessionId}>
                {project.workspaceTitle} · {project.path} · {project.sessionId.slice(-8)}
              </option>
            ))}
          </select>
          <button type="button" style={buttonStyle} disabled={!projectChoice || projectBusy} onClick={() => void bindProject()}>
            绑定
          </button>
          <button type="button" style={buttonStyle} disabled={projectBusy || !boundProject} onClick={() => void detachProject()}>
            解除绑定
          </button>
        </div>
        {projectMessage && (
          <div role="status" style={{ color: '#2f9e44', marginTop: 6, fontSize: 12 }}>{projectMessage}</div>
        )}
        {projectError && (
          <div role="alert" style={{ color: '#e5484d', marginTop: 6, fontSize: 12 }}>{projectError}</div>
        )}
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ ...titleStyle, marginBottom: 4 }}>主动通知节流</div>
        {notifyStatus ? (
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            今日已发 <strong>{notifyStatus.dailySent}</strong> / {notifyStatus.dailyLimit} 条 · 近一小时{' '}
            <strong>{notifyStatus.hourlySent}</strong> / {notifyStatus.hourlyLimit} 条 · 排队中{' '}
            <strong>{notifyStatus.pendingCount}</strong> 条
            <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
              agent 通过 wechat_notify 主动推送的通知，超限自动排队延迟发送，避免触发微信风控。
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, opacity: 0.7 }}>守护进程未运行，暂无数据。</div>
        )}
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ ...titleStyle, marginBottom: 4 }}>⏳ 超时安抚</div>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
          DSH 长时间没有产出消息时，主动发一条"还在处理"的安抚消息。改配置后即时生效（最长延迟数秒）。
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={calm.enabled}
            onChange={(e) => setCalm((c) => ({ ...c, enabled: e.target.checked }))}
          />
          启用安抚消息
        </label>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
          <label style={{ fontSize: 12 }}>
            首次静默（分钟）
            <input
              type="number"
              min={1}
              value={calm.silenceMin}
              onChange={(e) => setCalm((c) => ({ ...c, silenceMin: e.target.value }))}
              style={{ ...inputStyle, marginLeft: 6, minWidth: 70 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            重复间隔（分钟）
            <input
              type="number"
              min={1}
              value={calm.intervalMin}
              onChange={(e) => setCalm((c) => ({ ...c, intervalMin: e.target.value }))}
              style={{ ...inputStyle, marginLeft: 6, minWidth: 70 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            每轮上限（次，0=不限）
            <input
              type="number"
              min={0}
              value={calm.maxCount}
              onChange={(e) => setCalm((c) => ({ ...c, maxCount: e.target.value }))}
              style={{ ...inputStyle, marginLeft: 6, minWidth: 70 }}
            />
          </label>
        </div>
        <label style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
          自定义文案（每行一条，留空用内置默认；每次随机取一条）
          <textarea
            value={calm.messages}
            onChange={(e) => setCalm((c) => ({ ...c, messages: e.target.value }))}
            rows={3}
            style={{
              ...inputStyle,
              display: 'block',
              marginTop: 4,
              minWidth: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" style={buttonStyle} disabled={calmBusy} onClick={() => void saveCalm()}>
            保存安抚设置
          </button>
          {calmMessage && <span role="status" style={{ color: '#2f9e44', fontSize: 12 }}>{calmMessage}</span>}
          {calmError && <span role="alert" style={{ color: '#e5484d', fontSize: 12 }}>{calmError}</span>}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ ...titleStyle, marginBottom: 4 }}>🔐 信任用户（多用户）</div>
        {!trust ? (
          <div style={{ fontSize: 12, opacity: 0.7 }}>加载中…</div>
        ) : (
          <>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>
              信任模式
              <select
                value={trust.mode}
                onChange={(e) => changeTrustMode(e.target.value as TrustInfo['mode'])}
                disabled={trustBusy}
                style={{ ...inputStyle, marginLeft: 8, minWidth: 240 }}
                aria-label="选择信任模式"
              >
                <option value="owner-only">{TRUST_MODE_LABELS['owner-only']}</option>
                <option value="bootstrap">{TRUST_MODE_LABELS.bootstrap}</option>
                <option value="manual">{TRUST_MODE_LABELS.manual}</option>
              </select>
            </div>
            {trust.mode === 'bootstrap' && trust.bootstrapConsumed && (
              <div style={{ fontSize: 12, color: '#b7791f', marginBottom: 6 }}>
                ⚠️ bootstrap 首次名额已用完，后续陌生人不会再自动入集，请用下方表单手动添加或切到 manual。
              </div>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 8 }}>
              <input
                type="checkbox"
                checked={trust.notifyRejected}
                disabled={trustBusy}
                onChange={(e) => toggleNotifyRejected(e.target.checked)}
              />
              陌生人尝试联系时向 owner 推送提醒
            </label>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
              owner：{trust.owner || '（未绑定）'} · 信任用户：{trust.trusted.length} 个
            </div>
            {trust.trusted.length > 0 && (
              <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {trust.trusted.map((u) => (
                  <div
                    key={u.userId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 8px',
                      background: 'var(--surface-3, rgba(127,127,127,.05))',
                      border: '1px solid var(--border-color, rgba(127,127,127,.12))',
                      borderRadius: 6,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{u.userId}</span>
                    {u.note && <span style={{ opacity: 0.7, fontSize: 12 }}>{u.note}</span>}
                    <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.6 }}>
                      {u.by === 'bootstrap' ? '自动入集' : u.by === 'restore' ? '迁移导入' : '手动添加'} · {formatTime(u.lastSeenAt)}
                    </span>
                    <button
                      type="button"
                      style={{ ...buttonStyle, color: '#e5484d' }}
                      disabled={trustBusy}
                      onClick={() => removeTrustedUser(u.userId)}
                    >
                      吊销
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="text"
                value={newTrustId}
                onChange={(e) => setNewTrustId(e.target.value)}
                placeholder="要添加的微信 userId"
                style={{ ...inputStyle, minWidth: 180 }}
              />
              <input
                type="text"
                value={newTrustNote}
                onChange={(e) => setNewTrustNote(e.target.value)}
                placeholder="备注（可选）"
                style={{ ...inputStyle, minWidth: 120 }}
              />
              <button type="button" style={buttonStyle} disabled={trustBusy || !newTrustId.trim()} onClick={() => void addTrustedUser()}>
                添加信任
              </button>
            </div>
            {trustMessage && <div role="status" style={{ color: '#2f9e44', marginTop: 6, fontSize: 12 }}>{trustMessage}</div>}
            {trustError && <div role="alert" style={{ color: '#e5484d', marginTop: 6, fontSize: 12 }}>{trustError}</div>}
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
              信任用户与 owner 各自拥有独立会话、独立上下文，互不可见。撤销信任后其新消息将被拒绝，但已有历史保留。
              修改信任模式后，新入站消息立即生效，无需重启。
            </div>
          </>
        )}
      </div>

      {setupPhase === 'starting' && (
        <div role="status" style={{ marginBottom: 8 }}>正在生成二维码…</div>
      )}

      {setupPhase === 'qr' && qrcodeDataUrl && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>请用微信扫描下方二维码完成绑定</div>
          <img
            src={qrcodeDataUrl}
            alt="微信扫码绑定二维码"
            width={240}
            height={240}
            style={{ display: 'block', maxWidth: '100%', height: 'auto', borderRadius: 8, background: '#fff' }}
          />
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
            工作目录：{workingDir || '未设置'}。等待扫码确认中…
          </div>
          <button type="button" style={{ ...buttonStyle, marginTop: 8 }} onClick={cancelSetup}>
            取消绑定
          </button>
        </div>
      )}

      {setupPhase === 'confirmed' && (
        <div role="status" style={{ marginBottom: 8, color: '#2f9e44' }}>
          ✅ 绑定成功{boundAccountId ? `：${boundAccountId}` : ''}，{daemonMessage || '桥接已自动重启/启动。'}
        </div>
      )}

      {setupPhase === 'error' && (
        <div role="alert" style={{ marginBottom: 8, color: '#e5484d' }}>
          ❌ {setupError}
          <button type="button" style={{ ...buttonStyle, marginLeft: 8 }} onClick={() => setSetupPhase('idle')}>
            重新扫码
          </button>
        </div>
      )}

      <pre style={outputStyle} aria-live="polite">{output}</pre>

      <div style={buttonRowStyle}>
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            style={buttonStyle}
            disabled={action.disabled ?? false}
            onClick={action.run}
          >
            {action.label}
          </button>
        ))}
      </div>

      <div style={hintStyle}>
        也可在 DSH 对话中直接使用 wechat_bridge_setup / wechat_bridge_status / wechat_bridge_start / wechat_bridge_stop / wechat_bridge_logs 等工具。
      </div>
    </div>
  )
}
