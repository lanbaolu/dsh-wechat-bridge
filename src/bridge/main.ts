import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join, basename, extname } from 'node:path';
import { unlinkSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';

import { WeChatApi } from './wechat/api.js';
import { saveAccount, loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractFirstImageUrl, extractFirstFileItem, downloadFile } from './wechat/media.js';
import { createSessionStore, type Session } from './session.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { loadConfig, saveConfig } from './config.js';
import { loadJson, saveJson } from './store.js';
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';
import { loadPendingQueue, savePendingQueue, type PendingItem } from './pending-queue.js';
import { DshClient, type DshStreamEvent } from './dsh-client.js';
import { createNotifyThrottle } from './notify.js';
import { loadTrust, saveTrust, decideTrust, setTrustMode } from './trust.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 4000;

/**
 * Most recent WeChat user the daemon talked to (the bound user).
 * Fallback target for proactive notifications when account.userId is empty.
 */
let lastActiveUserId = '';

/**
 * iLink 主动发消息（bot → 用户）必须回传该用户最近一次入站消息携带的
 * context_token，空 token 会被服务端拒绝（ret:-2 "prepare failed"）。
 *
 * P1-2 / M3：每个受信用户各存一份（入站消息按 from_user_id 刷新），
 * 主动通知 / 审批推送显式带 userId 取对应 token；`lastContextToken`
 * 保留为兜底（未带 userId 的旧调用路径 / 未知用户回退）。
 */
const contextTokens = new Map<string, string>();
let lastContextToken = '';

function contextTokenPath(): string {
  return join(DATA_DIR, 'context-token.json');
}

function contextTokensPath(): string {
  return join(DATA_DIR, 'context-tokens.json');
}

function persistContextTokens(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tokens: Record<string, string> = {};
    for (const [k, v] of contextTokens) tokens[k] = v;
    writeFileSync(contextTokensPath(), JSON.stringify({ tokens, updatedAt: Date.now() }) + '\n', 'utf8');
    // 旧单 token 文件继续写（最近一条），老版本工具/排查脚本仍可读。
    writeFileSync(contextTokenPath(), JSON.stringify({ token: lastContextToken, updatedAt: Date.now() }) + '\n', 'utf8');
    // 敏感 token 文件与 trust/config 对齐 0600，避免同机其他用户可读。
    if (process.platform !== 'win32') {
      chmodSync(contextTokensPath(), 0o600);
      chmodSync(contextTokenPath(), 0o600);
    }
  } catch (err) {
    logger.warn('Failed to persist context tokens', { error: err instanceof Error ? err.message : String(err) });
  }
}

function loadContextToken(): void {
  // per-user 表
  try {
    const parsed = JSON.parse(readFileSync(contextTokensPath(), 'utf8')) as { tokens?: Record<string, string> };
    for (const [k, v] of Object.entries(parsed.tokens ?? {})) {
      if (typeof v === 'string' && v && k) contextTokens.set(k, v);
    }
  } catch {
    // 首次启动没有文件属正常
  }
  // 旧单 token 兜底
  try {
    const parsed = JSON.parse(readFileSync(contextTokenPath(), 'utf8')) as { token?: unknown };
    lastContextToken = typeof parsed.token === 'string' ? parsed.token : '';
  } catch {
    lastContextToken = '';
  }
}

/** 主动推送取 token：优先该用户最近入站的，缺省回退全局最近一条。 */
function contextTokenFor(userId?: string): string {
  if (userId && contextTokens.has(userId)) return contextTokens.get(userId)!;
  return lastContextToken;
}

function updateContextToken(userId: string, token: string): void {
  if (!token) return;
  let changed = false;
  if (userId && contextTokens.get(userId) !== token) {
    contextTokens.set(userId, token);
    changed = true;
  }
  if (token !== lastContextToken) {
    lastContextToken = token;
    changed = true;
  }
  if (changed) persistContextTokens();
}

// ---------------------------------------------------------------------------
// 崩溃安全：跨进程轮询锁 + 入站去重
// ---------------------------------------------------------------------------

/**
 * 跨进程轮询锁：同一时刻只允许一个 daemon 轮询微信账号（getupdates 游标
 * 双写会互相吞消息、双写会话日志）。pid 存活 + 90s 心跳判断，陈旧锁自动
 * 接管（宿主看门狗重启 / 上次崩溃残留都不会卡死）。
 */
const POLL_LOCK_PATH = join(DATA_DIR, 'poll.lock');

function readPollLock(): { pid?: number; heartbeat?: number } | null {
  try {
    return JSON.parse(readFileSync(POLL_LOCK_PATH, 'utf8')) as { pid?: number; heartbeat?: number };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePollLock(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(POLL_LOCK_PATH, JSON.stringify({ pid: process.pid, heartbeat: Date.now() }) + '\n', 'utf8');
  } catch (err) {
    logger.warn('Failed to write poll lock', { error: err instanceof Error ? err.message : String(err) });
  }
}

function acquirePollLock(): boolean {
  const existing = readPollLock();
  if (existing && typeof existing.pid === 'number' && existing.pid !== process.pid
      && isPidAlive(existing.pid)
      && typeof existing.heartbeat === 'number'
      && existing.heartbeat > Date.now() - 90_000) {
    return false;
  }
  writePollLock();
  return true;
}

/**
 * 入站去重：崩溃重投 / 轮询重叠窗口里 getupdates 可能重放已处理消息，
 * 按 message_id（缺省回退 seq）直接跳过。最近条目持久化，重启后仍生效。
 */
const DEDUP_PATH = join(DATA_DIR, 'dedup.json');
const DEDUP_TTL_MS = 60 * 60 * 1000;
const seenMessages = new Map<string, number>();
let dedupSaveTimer: ReturnType<typeof setTimeout> | undefined;

function loadDedup(): void {
  const parsed = loadJson<{ entries?: Record<string, number> }>(DEDUP_PATH, { entries: {} });
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [key, ts] of Object.entries(parsed.entries ?? {})) {
    if (typeof ts === 'number' && ts > cutoff) seenMessages.set(key, ts);
  }
}

/** 返回 true = 首次见到（应处理）；false = 重复（应跳过）。 */
function markSeen(key: string): boolean {
  if (seenMessages.has(key)) return false;
  seenMessages.set(key, Date.now());
  if (seenMessages.size > 1000) {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [k, ts] of seenMessages) {
      if (ts < cutoff) seenMessages.delete(k);
    }
  }
  return true;
}

function scheduleDedupSave(): void {
  if (dedupSaveTimer) return;
  dedupSaveTimer = setTimeout(() => {
    dedupSaveTimer = undefined;
    try {
      const entries: Record<string, number> = {};
      for (const [k, ts] of seenMessages) entries[k] = ts;
      saveJson(DEDUP_PATH, { entries });
    } catch {
      // 去重表丢失只影响崩溃重投场景，不阻塞消息处理
    }
  }, 1000);
  dedupSaveTimer.unref?.();
}

/** Extensions eligible for auto-push when detected in DSH's response text. */
const AUTO_PUSH_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.rtf',
  '.txt', '.md',
  '.csv', '.xlsx', '.xls',
  '.mp3', '.wav', '.m4a', '.mp4', '.mov',
]);

/** Extract local file paths from DSH response text (macOS/Linux/Windows). */
function extractFilePathsFromText(text: string, cwd: string): string[] {
  const paths: string[] = [];
  const regex = /(?:\/(?:Users|home|tmp|var|etc)\/[^\s`'"()\[\]{}|<>]+\.\w+|~\/[^\s`'"()\[\]{}|<>]+\.\w+|[A-Za-z]:[\\\/][^\s`'"()\[\]{}|<>]+\.\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const resolved = raw.startsWith('~')
      ? raw.replace(/^~/, homedir())
      : raw;
    // Also resolve relative paths that are absolute-ish under the cwd.
    paths.push(resolved.startsWith('/') || /^[A-Za-z]:[\\/]/.test(resolved) ? resolved : join(cwd, resolved));
  }
  return paths;
}

/** Silence keepalive messages sent when DSH has not produced output for a while. */
const SILENCE_MESSAGES = [
  '我还在处理中，这个问题有点复杂，请再稍等一下',
  '正在努力干活中，马上就有结果了，请稍等片刻',
  '有点复杂正在处理，再给我一点时间，很快就好',
  '快好了别着急，正在收尾阶段，马上给你回复',
  '还在跑呢，任务量比较大，不过马上就能出结果了',
  '正在处理中，进展顺利，再等一会儿就好',
];

/** Split text into blocks at paragraph boundaries (double newlines). */
function parseBlocks(text: string): string[] {
  return text.split(/\n\n+/).filter(block => block.length > 0);
}

/** Find a safe split point that won't break markdown formatting. */
function findSafeSplitPoint(text: string, maxLen: number): number {
  let idx = text.lastIndexOf('\n', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  const sentenceEnd = /[。！？.!?]$/;
  for (let i = maxLen; i >= maxLen * 0.5; i--) {
    if (sentenceEnd.test(text.slice(i - 1, i))) return i;
  }

  idx = text.lastIndexOf(' ', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  return maxLen;
}

/** Fallback: split a single oversized block at safe boundaries. */
function splitByNewline(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const splitIdx = findSafeSplitPoint(remaining, maxLen);
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

/** Split a message into WeChat-safe chunks, preserving paragraphs. */
/**
 * 从流式缓冲头部切出一段待发文本：优先在换行边界截断（≤ maxChars，不切词）；
 * 找不到合适边界时按 maxChars 硬切（罕见，长串无换行文本）。返回 [切出部分, 剩余]。
 */
function takeBatch(buffer: string, maxChars: number): [string, string] {
  if (buffer.length <= maxChars) return [buffer, ''];
  const windowText = buffer.slice(0, maxChars);
  const cut = windowText.lastIndexOf('\n');
  // 边界太靠前（不足一半）就放弃边界硬切，避免切出过短碎片。
  if (cut >= maxChars / 2) return [windowText.slice(0, cut), buffer.slice(cut + 1)];
  return [windowText, buffer.slice(maxChars)];
}

function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const blocks = parseBlocks(text);
  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    if (current.length === 0) {
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
      }
    } else if (current.length + 2 + block.length <= maxLen) {
      current += '\n\n' + block;
    } else {
      chunks.push(current);
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
        current = '';
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/** Open a file using the platform's default application (cross-platform). */
function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    cmd = 'xdg-open';
    args = [filePath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const QR_PATH = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置 DSH 微信桥接...\n');

  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    const isHeadlessLinux = process.platform === 'linux'
      && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
        console.log('二维码链接：', qrcodeUrl);
        console.log();
      } catch {
        logger.warn('qrcode-terminal not available, falling back to URL');
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(QR_PATH, pngData);
      openFile(QR_PATH);
      console.log('已打开二维码图片，请用微信扫描：');
      console.log(`图片路径: ${QR_PATH}\n`);
    }

    console.log('等待扫码绑定...');

    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  try { unlinkSync(QR_PATH); } catch {
    logger.warn('Failed to clean up QR image', { path: QR_PATH });
  }

  const workingDir = await promptUser('请输入 DSH 工作目录', join(homedir(), 'Documents', 'DSH'));
  const config = loadConfig();
  config.workingDirectory = workingDir;
  saveConfig(config);

  console.log('绑定完成。可在 DSH 插件面板或命令行执行 wechat_bridge_start 启动服务。');
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const loadedAccount = loadLatestAccount();

  if (!loadedAccount) {
    console.error('未找到微信账号，请先运行: node lib/bridge/main.js setup');
    process.exit(1);
  }
  // 守卫后 account 必非 null；闭包（信任门禁等）拿不到收窄，这里显式声明非空。
  const account: AccountData = loadedAccount;

  const apiBase = process.env.DSH_BRIDGE_API_BASE;
  const apiToken = process.env.DSH_BRIDGE_API_TOKEN;
  if (!apiBase || !apiToken) {
    console.error('缺少 DSH_BRIDGE_API_BASE / DSH_BRIDGE_API_TOKEN 环境变量（应由 DSH 插件启动时注入）');
    process.exit(1);
  }

  const client = new DshClient(apiBase, apiToken);
  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore({
    botAccountId: account.accountId,
    ownerUserId: account.userId,
    defaultWorkingDirectory: config.workingDirectory,
  });
  // 升级到多用户：把旧单用户数据 ${accountId}.json 迁移到 ${accountId}__${ownerUserId}.json，
  // 并把本 bot 所有会话的陈旧 'processing' 状态重置为 'idle'（崩溃恢复）。
  sessionStore.runMigrations();
  sessionStore.resetStaleStates();

  const sender = createSender(api, account.accountId);
  lastActiveUserId = account.userId || '';
  loadContextToken();
  loadDedup();

  // -------------------------------------------------------------------------
  // Proactive notification endpoint (DSH → daemon), throttled.
  // WeChat personal accounts are sensitive to proactive high-frequency pushes,
  // so notifications go through a queue + rate limits (see notify.ts).
  // P1-2 / M3：body 可带 userId 指定目标用户（取该用户的 context_token），
  // 缺省回退 lastActiveUserId（旧调用路径兼容）。
  // -------------------------------------------------------------------------
  const notifyThrottle = createNotifyThrottle((message, userId) => {
    const target = userId || lastActiveUserId;
    return sender.sendText(target, contextTokenFor(target), message);
  });
  const notifyPortPath = join(DATA_DIR, 'daemon-port.json');
  const notifyServer = createServer((req, res) => {
    const token = process.env.DSH_BRIDGE_API_TOKEN;
    if (!token || req.headers['x-dsh-bridge-token'] !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    if (req.method === 'GET' && (req.url === '/notify/status' || req.url === '/notify/status/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(notifyThrottle.getStatus()));
      return;
    }
    const isNotify = req.url === '/notify' || req.url === '/notify/';
    const isApproval = req.url === '/approval' || req.url === '/approval/';
    if (req.method !== 'POST' || (!isNotify && !isApproval)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { message?: unknown; userId?: unknown };
        const message = String(parsed?.message ?? '');
        const targetUserId = typeof parsed?.userId === 'string' && parsed.userId ? parsed.userId : undefined;
        // 审批是阻塞交互且量极低（由用户自己的任务触发），绕过节流直发，
        // 否则 60s 的最小通知间隔会把审批拖到超时。
        if (isApproval) {
          if (!message.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'empty message' }));
            return;
          }
          const target = targetUserId || lastActiveUserId;
          sender.sendText(target, contextTokenFor(target), message)
            .then(() => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            })
            .catch((err: unknown) => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
            });
          return;
        }
        const result = notifyThrottle.enqueue(message, targetUserId);
        res.writeHead(result.accepted ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad request' }));
      }
    });
  });

  await new Promise<void>((resolve) => notifyServer.listen(0, '127.0.0.1', resolve));
  const notifyPort = (notifyServer.address() as { port: number }).port;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(notifyPortPath, JSON.stringify({ port: notifyPort, token: process.env.DSH_BRIDGE_API_TOKEN }, null, 2) + '\n', 'utf8');
    logger.info('Proactive notify endpoint ready', { port: notifyPort });
  } catch (err) {
    logger.warn('Failed to persist notify endpoint info', { error: err instanceof Error ? err.message : String(err) });
  }
  // -------------------------------------------------------------------------
  // P1-2 / M3：per-user 消息队列——A 的长任务不再阻塞 B。
  // 每个用户一条队列串行消费；用户之间并行（host 侧本来就是独立 agent）。
  // -------------------------------------------------------------------------
  const messageQueues = new Map<string, WeixinMessage[]>();
  const drainingUsers = new Set<string>();

  function enqueueMessage(msg: WeixinMessage): void {
    const uid = msg.from_user_id!;
    let q = messageQueues.get(uid);
    if (!q) {
      q = [];
      messageQueues.set(uid, q);
    }
    q.push(msg);
    void drainUserQueue(uid);
  }

  async function drainUserQueue(userId: string): Promise<void> {
    if (drainingUsers.has(userId)) return;
    drainingUsers.add(userId);
    try {
      const q = messageQueues.get(userId);
      while (q && q.length > 0) {
        const msg = q.shift()!;
        await handleMessage(msg, account!, sessionStore, sender, config, client, q);
      }
    } catch (err) {
      logger.error('drainUserQueue failed', { userId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      drainingUsers.delete(userId);
    }
  }

  /**
   * 信任门禁判定（供 onMessage / 优先命令复用）：
   * 返回 null = 放行；返回字符串 = 拒绝原因（已记日志，必要时已通知 owner）。
   * bootstrap 自动入集 / lastSeenAt 刷新等副作用在此落盘（lastSeenAt 60s 节流）。
   */
  let lastTrustSeenPersist = 0;
  function checkTrustGate(msg: WeixinMessage): string | null {
    const trustFile = loadTrust();
    const decision = decideTrust({
      fromUserId: msg.from_user_id ?? '',
      ownerUserId: account.userId,
      file: trustFile,
    });
    if (decision.file !== trustFile) {
      // bootstrap 自动入集必落盘；trusted 分支的 lastSeenAt 刷新节流到 60s 一次，
      // 避免每条消息都写盘（面板「最近活跃」有秒级精度足够）。
      if (decision.reason !== 'trusted' || Date.now() - lastTrustSeenPersist > 60_000) {
        saveTrust(decision.file);
        lastTrustSeenPersist = Date.now();
      }
    }
    if (decision.allowed) return null;
    logger.info('Inbound message rejected by trust gate', {
      fromUserId: msg.from_user_id,
      reason: decision.reason,
      mode: trustFile.mode,
    });
    // 可选：通知 owner 有人尝试联系（不回复陌生人，避免泄露任何内部信息）。
    // 走 notifyThrottle 队列，避免陌生人多条消息刷屏直撞 iLink 主动推送风控。
    if (config.notifyRejected && account.userId && msg.item_list) {
      const text = extractTextFromItems(msg.item_list).slice(0, 80) || '(非文本)';
      const hint = `🔒 陌生人尝试联系：${msg.from_user_id}\n内容预览：${text}`;
      notifyThrottle.enqueue(hint, account.userId);
    }
    return decision.reason;
  }

  function handlePriorityCommand(msg: WeixinMessage): boolean {
    if (msg.message_type !== MessageType.USER || !msg.item_list) return false;
    // 破坏性命令（取消进行中任务 / 清空会话）：发送者必须先过信任门禁
    // （onMessage 已检），且只作用于自己的会话。
    // owner-only 模式下与原行为一致：仅 owner 本人。
    const ownerId = account?.userId;
    const trustFile = loadTrust();
    if (trustFile.mode === 'owner-only') {
      if (!ownerId || msg.from_user_id !== ownerId) return false;
    } else if (!msg.from_user_id) {
      return false;
    }
    const text = extractTextFromItems(msg.item_list);
    if (!/^\/(?:stop|clear|new)(?:\s|$)/i.test(text)) return false;
    const userId = msg.from_user_id!;
    const sessionKey = sessionStore.keyFor(userId);
    const userSession = sessionStore.load(userId);
    if (userSession.state !== 'processing') return false;

    // 只清自己的排队消息，不影响其他用户。
    const q = messageQueues.get(userId);
    if (q) q.length = 0;
    if (/^\/(?:clear|new)(?:\s|$)/i.test(text)) {
      const cleared = sessionStore.clear(userId, userSession);
      Object.assign(userSession, cleared);
    } else {
      userSession.state = 'idle';
      sessionStore.save(userId, userSession);
    }

    if (text.trim().toLowerCase().startsWith('/stop')) {
      client.stop(sessionKey).catch(() => {});
      sender.sendText(userId, msg.context_token ?? '', '⏹ 已停止当前对话，排队中的消息已清空。').catch(() => {});
    } else {
      client.clear(sessionKey).catch(() => {});
      sender.sendText(userId, msg.context_token ?? '', '✅ 会话已清除。').catch(() => {});
    }
    return true;
  }

  /**
   * 审批回复是时间敏感的交互（host 侧的 agent 正挂着等裁决），必须像
   * /stop 一样抢在消息队列之前处理——否则排队到任务结束就死锁到超时。
   * 多用户下任何受信用户都可回复 /yes /no，但只裁决自己 session 的 pending
   * （host 侧 approvalManager 按 session key 归属，双保险）。
   */
  async function handleApprovalReply(msg: WeixinMessage): Promise<boolean> {
    if (msg.message_type !== MessageType.USER || !msg.item_list) return false;
    const ownerId = account?.userId;
    const trustFile = loadTrust();
    if (trustFile.mode === 'owner-only') {
      if (!ownerId || msg.from_user_id !== ownerId) return false;
    } else if (!msg.from_user_id) {
      return false;
    }
    const text = extractTextFromItems(msg.item_list).trim();
    const match = /^\/(yes|no)(?:\s|$)/i.exec(text);
    if (!match) return false;
    const approved = match[1].toLowerCase() === 'yes';
    const userId = msg.from_user_id!;
    const sessionKey = sessionStore.keyFor(userId);

    let reply: string;
    try {
      const result = await client.decideApproval(sessionKey, approved);
      if (result.ok) {
        reply = approved
          ? `✅ 已批准${result.toolName ? `：${result.toolName}` : ''}，任务继续执行。`
          : `🚫 已拒绝${result.toolName ? `：${result.toolName}` : ''}。`;
      } else if (result.reason === 'disabled') {
        reply = 'ℹ️ 微信审批未启用，请在电脑端处理该请求。';
      } else {
        reply = '当前没有待审批的请求（可能已超时自动拒绝）。';
      }
    } catch {
      reply = '⚠️ 审批结果未能送达 DSH，请到电脑端确认任务状态。';
    }
    await sender.sendText(userId, msg.context_token ?? '', reply).catch(() => {});
    return true;
  }

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      // 崩溃安全：重复投递（崩溃重投 / 轮询重叠）直接跳过。
      const dedupKey = msg.message_id !== undefined && msg.message_id !== null
        ? `id:${String(msg.message_id)}`
        : (msg as { seq?: unknown }).seq !== undefined ? `seq:${String((msg as { seq?: unknown }).seq)}` : '';
      if (dedupKey) {
        if (!markSeen(dedupKey)) {
          logger.debug('Duplicate inbound message skipped', { dedupKey });
          return;
        }
        scheduleDedupSave();
      }

      // P1-2 / M1：信任门禁——优先命令与审批回复也受门禁约束（在门禁之后处理）。
      if (msg.message_type === MessageType.USER && msg.from_user_id) {
        if (checkTrustGate(msg) !== null) return;
        // 受信用户的每条入站消息都刷新该用户的 context_token（主动推送通行证）。
        if (msg.context_token) {
          lastActiveUserId = msg.from_user_id;
          updateContextToken(msg.from_user_id, msg.context_token);
        }
      }

      if (handlePriorityCommand(msg)) return;
      if (await handleApprovalReply(msg)) return;
      if (msg.message_type === MessageType.USER && msg.from_user_id) {
        enqueueMessage(msg);
      }
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...');
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  };

  // 崩溃安全：拒绝第二个活着的 daemon 同时轮询（游标双写会互相吞消息）。
  if (!acquirePollLock()) {
    console.error('⚠️ 另一个桥接守护进程正在轮询本账号，本进程退出。若确无其他实例运行，删除 ~/.dsh/wechat-bridge/poll.lock 后重试。');
    process.exit(1);
  }
  const lockTimer = setInterval(writePollLock, 30_000);
  lockTimer.unref?.();

  const monitor = createMonitor(api, callbacks);

  function shutdown(): void {
    logger.info('Shutting down...');
    monitor.stop();
    notifyServer.close();
    notifyThrottle.stop();
    clearInterval(lockTimer);
    try {
      const lock = readPollLock();
      if (lock?.pid === process.pid) unlinkSync(POLL_LOCK_PATH);
    } catch { /* ignore */ }
    try { unlinkSync(notifyPortPath); } catch { /* ignore */ }
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId: account.accountId });
  console.log(`已启动 (账号: ${account.accountId})`);

  await monitor.run();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  client: DshClient,
  messageQueue: WeixinMessage[],
): Promise<void> {
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;

  // 门禁判定（拒绝/放行）已在 onMessage 统一执行（含优先命令与审批回复），
  // 这里重读 trust.json 只是为了给命令上下文提供当前信任状态（trustCtx），不是重复判定。
  const trustFile = loadTrust();

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;

  // 加载该用户的独立 session（P1-2 / M2：per-user 会话隔离）。
  const session = sessionStore.load(fromUserId);

  const userText = extractTextFromItems(msg.item_list);
  const imageItem = extractFirstImageUrl(msg.item_list);
  const fileItem = extractFirstFileItem(msg.item_list);

  // While the current turn is running, keep ordinary messages queued and
  // process them after this turn finishes, instead of dropping them.
  if (session.state === 'processing' && !userText.startsWith('/')) {
    messageQueue.push(msg);
    return;
  }

  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(fromUserId, session);
    };

    const trustCtx = trustFile.mode === 'owner-only'
      ? undefined
      : {
          load: loadTrust,
          save: saveTrust,
          listModeLabel: () => {
            switch (trustFile.mode) {
              case 'owner-only': return 'owner-only（仅本机主人）';
              case 'bootstrap': return `bootstrap${trustFile.bootstrapConsumed ? '（已用完首次）' : '（首次联系自动入集）'}`;
              case 'manual': return 'manual（仅 /trust 添加的人）';
            }
          },
        };

    const ctx: CommandContext = {
      accountId: account.accountId,
      fromUserId,
      ownerUserId: account.userId,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(fromUserId),
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      text: userText,
      listProjects: () => client.listProjects(),
      selectProject: (sessionId: string) => client.selectProject(sessionId),
      detachProject: () => client.detachProject(),
      getStatus: () => client.status(),
      trust: trustCtx,
    };

    const result: CommandResult = await routeCommand(ctx);

    // /trustmode 的副作用：写入 trust.json（唯一真相源），并即时刷新内存视图。
    if (result.setTrustMode) {
      const updated = setTrustMode(loadTrust(), result.setTrustMode);
      saveTrust(updated);
    }

    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      // /clear and /new must also clear the real DSH session (and its persisted
      // id mapping), even when the daemon is idle and not just mid-turn.
      if (/^\/(?:clear|new)(?:\s|$)/i.test(userText.trim())) {
        const sessionKey = sessionStore.keyFor(fromUserId);
        await client.clear(sessionKey).catch((err) => {
          logger.warn('Failed to clear DSH session from slash command', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return;
    }

    if (result.handled && result.sendFile) {
      await sender.sendFile(fromUserId, contextToken, result.sendFile);
      return;
    }

    if (result.handled && result.dshPrompt) {
      await sendToDsh(result.dshPrompt, imageItem, fileItem, fromUserId, contextToken,
        account, session, sessionStore, sender, config, client);
      return;
    }

    if (result.handled) return;
  }

  if (!userText && !imageItem && !fileItem) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、语音、图片或文件');
    return;
  }

  await sendToDsh(userText, imageItem, fileItem, fromUserId, contextToken,
    account, session, sessionStore, sender, config, client);
}

async function sendToDsh(
  userText: string,
  imageItem: ReturnType<typeof extractFirstImageUrl>,
  fileItem: ReturnType<typeof extractFirstFileItem>,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  client: DshClient,
): Promise<void> {
  // P1-2 / M2：session key = botAccountId::userId —— 每个微信用户独立会话。
  // owner 也走同一套路径（与迁移后的数据一致）。
  const sessionKey = sessionStore.keyFor(fromUserId);

  session.state = 'processing';
  sessionStore.save(fromUserId, session);

  sessionStore.addChatMessage(session, 'user', userText || '(图片/文件)');
  const stopTyping = sender.startTyping(fromUserId, contextToken);

  try {
    // Download media to local paths; DSH can read them from disk.
    const files: string[] = [];
    let prompt = userText || '请处理这条消息';

    if (imageItem) {
      const filePath = await downloadImage(imageItem);
      if (filePath) {
        files.push(filePath);
        prompt = userText
          ? `${userText}\n\n用户发送了图片，已保存到: ${filePath}\n请查看这张图片。`
          : `用户发送了图片，已保存到: ${filePath}\n请查看这张图片。`;
      }
    }

    if (fileItem) {
      const filePath = await downloadFile(fileItem);
      if (filePath) {
        files.push(filePath);
        const fileName = fileItem.file_item?.file_name || basename(filePath);
        prompt = userText
          ? `${userText}\n\n用户发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请先读取这个文件再回答。`
          : `用户发送了文件: ${fileName}\n文件已保存到: ${filePath}\n请读取这个文件并总结其内容。`;
      }
    }

    const accepted = await client.prompt({
      text: prompt,
      sessionId: sessionKey,
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir()),
      model: session.model,
      systemPrompt: config.systemPrompt,
      files,
    });

    if (!accepted) {
      await sender.sendText(fromUserId, contextToken, '消息已收到，但 DSH 未接受处理请求。');
      session.state = 'idle';
      sessionStore.save(fromUserId, session);
      return;
    }

    // Stream the assistant response back.
    let finalText = '';
    let flushTimer: ReturnType<typeof setInterval> | undefined;
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    let pendingSend = '';
    let lastSentTime = Date.now();
    let turnUsage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined;

    // 流式攒批策略：攒够字数或流停顿时才发送，避免碎片消息刷屏：
    //  - 缓冲 ≥ 1200 字：立即按自然边界切出一段发送（见 chunk 分支）；
    //  - 缓冲 ≥ 600 字：定时器补一刀发掉；
    //  - 流停顿超过 2.5s（生成间隙）：把尾巴发出去，别让用户干等；
    //  - 其余情况继续攒——宁可少发几条整的，也不要把一句话切成三段。
    const BATCH_TICK_MS = 800;
    const BATCH_MIN_CHARS = 600;
    const STREAM_STALL_MS = 2500;
    let lastChunkTime = Date.now();

    const flush = async (maxChars?: number): Promise<void> => {
      if (!pendingSend) return;
      let text: string;
      if (maxChars !== undefined) {
        [text, pendingSend] = takeBatch(pendingSend, maxChars);
      } else {
        text = pendingSend;
        pendingSend = '';
      }
      for (const chunk of splitMessage(text)) {
        try {
          await sender.sendText(fromUserId, contextToken, chunk);
          lastSentTime = Date.now();
        } catch (err) {
          logger.warn('Flush send failed, will retry on next flush', {
            error: err instanceof Error ? err.message : String(err),
          });
          pendingSend = text + (pendingSend ? '\n\n' + pendingSend : '');
          return;
        }
      }
    };

    flushTimer = setInterval(() => {
      if (!pendingSend) return;
      if (pendingSend.length >= BATCH_MIN_CHARS || Date.now() - lastChunkTime > STREAM_STALL_MS) {
        void flush().catch(() => {});
      }
    }, BATCH_TICK_MS);

    // 超时安抚：如果 5 分钟没有产出任何消息，主动告诉用户还在处理。
    const SILENCE_WARNING_MS = 5 * 60 * 1000;
    keepaliveTimer = setInterval(() => {
      if (Date.now() - lastSentTime > SILENCE_WARNING_MS) {
        const msg = SILENCE_MESSAGES[Math.floor(Math.random() * SILENCE_MESSAGES.length)];
        sender.sendText(fromUserId, contextToken, msg).catch(() => {});
        lastSentTime = Date.now();
      }
    }, 2000);

    const controller = new AbortController();
    await client.stream(sessionKey, (event: DshStreamEvent) => {
      switch (event.type) {
        case 'chunk':
          if (event.text) {
            finalText += event.text;
            pendingSend += event.text;
            lastChunkTime = Date.now();
            // 缓冲攒大后按自然边界切出一段先发（不切词），剩余的继续攒。
            if (pendingSend.length >= 1200) {
              void flush(1200).catch(() => {});
            }
          }
          break;
        case 'status':
          // Optional status updates are currently not pushed to WeChat.
          break;
        case 'error':
          if (event.message) {
            finalText += `\n\n⚠️ ${event.message}`;
          }
          break;
        case 'done':
          // 流结束：记录本轮用量（供尾注），剩余缓冲由下方 flush 兜底。
          if (event.usage) turnUsage = event.usage;
          break;
      }
    }, controller.signal);

    if (flushTimer) clearInterval(flushTimer);
    if (keepaliveTimer) clearInterval(keepaliveTimer);

    // 上下文用量尾注：inputTokens + cacheReadTokens ≈ 当前上下文大小。
    // 并入最后一段缓冲一起发，不额外产生消息（config.json 可关：usageFooter=false）。
    if (config.usageFooter !== false && turnUsage) {
      const ctxK = Math.round(((turnUsage.inputTokens ?? 0) + (turnUsage.cacheReadTokens ?? 0)) / 100) / 10;
      const out = turnUsage.outputTokens ?? 0;
      if (ctxK > 0) {
        pendingSend += `\n\n🧮 上下文约 ${ctxK}k tokens · 本轮输出 ${out}`;
      }
    }

    await flush();

    const resultText = finalText.trim();
    if (resultText) {
      sessionStore.addChatMessage(session, 'assistant', resultText);
      if (!resultText.startsWith('⚠️')) {
        // Auto-push deliverable files mentioned in DSH's response.
        const cwd = (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir());
        const detectedPaths = extractFilePathsFromText(resultText, cwd);
        const pushable = detectedPaths.filter(f => {
          const ext = extname(f).toLowerCase();
          return AUTO_PUSH_EXTENSIONS.has(ext) && existsSync(f);
        });
        for (const filePath of pushable) {
          try {
            await sender.sendFile(fromUserId, contextToken, filePath);
          } catch (err) {
            logger.warn('Failed to auto-push file', {
              filePath,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } else {
      await sender.sendText(fromUserId, contextToken, 'DSH 无返回内容。');
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Error in sendToDsh', { error: errorMsg });
    await sender.sendText(fromUserId, contextToken, '处理消息时出错，请稍后重试。');
  } finally {
    session.state = 'idle';
    sessionStore.save(fromUserId, session);
    stopTyping();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
