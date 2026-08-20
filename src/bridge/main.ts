import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join, basename, extname } from 'node:path';
import { unlinkSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';
import { loadPendingQueue, savePendingQueue, type PendingItem } from './pending-queue.js';
import { DshClient, type DshStreamEvent } from './dsh-client.js';
import { createNotifyThrottle } from './notify.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 4000;

/**
 * Most recent WeChat user the daemon talked to (the bound user).
 * Fallback target for proactive notifications when account.userId is empty.
 */
let lastActiveUserId = '';

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
  const account = loadLatestAccount();

  if (!account) {
    console.error('未找到微信账号，请先运行: node lib/bridge/main.js setup');
    process.exit(1);
  }

  const apiBase = process.env.DSH_BRIDGE_API_BASE;
  const apiToken = process.env.DSH_BRIDGE_API_TOKEN;
  if (!apiBase || !apiToken) {
    console.error('缺少 DSH_BRIDGE_API_BASE / DSH_BRIDGE_API_TOKEN 环境变量（应由 DSH 插件启动时注入）');
    process.exit(1);
  }

  const client = new DshClient(apiBase, apiToken);
  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore();
  const session: Session = sessionStore.load(account.accountId);

  if (config.workingDirectory && session.workingDirectory === process.cwd()) {
    session.workingDirectory = config.workingDirectory;
    sessionStore.save(account.accountId, session);
  }

  if (session.state !== 'idle') {
    logger.warn('Resetting stale session state on startup', { state: session.state });
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  }

  const sender = createSender(api, account.accountId);
  lastActiveUserId = account.userId || '';

  // -------------------------------------------------------------------------
  // Proactive notification endpoint (DSH → daemon), throttled.
  // WeChat personal accounts are sensitive to proactive high-frequency pushes,
  // so notifications go through a queue + rate limits (see notify.ts).
  // -------------------------------------------------------------------------
  const notifyThrottle = createNotifyThrottle((message) =>
    sender.sendText(lastActiveUserId, '', message));
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
    if (req.method !== 'POST' || (req.url !== '/notify' && req.url !== '/notify/')) {
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
        const parsed = JSON.parse(body) as { message?: unknown };
        const result = notifyThrottle.enqueue(String(parsed?.message ?? ''));
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
  const messageQueue: WeixinMessage[] = [];
  let processingQueue = false;

  async function drainQueue(): Promise<void> {
    if (processingQueue) return;
    processingQueue = true;
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift()!;
      await handleMessage(msg, account!, session, sessionStore, sender, config, client, messageQueue);
    }
    processingQueue = false;
  }

  function handlePriorityCommand(msg: WeixinMessage): boolean {
    if (msg.message_type !== MessageType.USER || !msg.item_list) return false;
    // Priority commands are destructive (cancel in-flight turn / clear session).
    // Fail-closed sender check: only the bound account owner may trigger them,
    // otherwise any contact could stop or wipe someone's running work.
    const ownerId = account?.userId;
    if (!ownerId || msg.from_user_id !== ownerId) return false;
    const text = extractTextFromItems(msg.item_list);
    if (!/^\/(?:stop|clear|new)(?:\s|$)/i.test(text)) return false;
    if (session.state !== 'processing') return false;

    messageQueue.length = 0;
    if (/^\/(?:clear|new)(?:\s|$)/i.test(text)) {
      const cleared = sessionStore.clear(account!.accountId, session);
      Object.assign(session, cleared);
    } else {
      session.state = 'idle';
      sessionStore.save(account!.accountId, session);
    }

    if (text.trim().toLowerCase().startsWith('/stop')) {
      client.stop(account!.accountId).catch(() => {});
      sender.sendText(msg.from_user_id!, msg.context_token ?? '', '⏹ 已停止当前对话，排队中的消息已清空。').catch(() => {});
    } else {
      client.clear(account!.accountId).catch(() => {});
      sender.sendText(msg.from_user_id!, msg.context_token ?? '', '✅ 会话已清除。').catch(() => {});
    }
    return true;
  }

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      if (handlePriorityCommand(msg)) return;
      messageQueue.push(msg);
      drainQueue();
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...');
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  };

  const monitor = createMonitor(api, callbacks);

  function shutdown(): void {
    logger.info('Shutting down...');
    monitor.stop();
    notifyServer.close();
    notifyThrottle.stop();
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
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  client: DshClient,
  messageQueue: WeixinMessage[],
): Promise<void> {
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;
  // Fail-closed: with no known owner we accept nobody. login.ts guarantees a
  // real userId on save, but an empty/legacy field must deny, not allow-all.
  if (!account.userId || msg.from_user_id !== account.userId) return;

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  lastActiveUserId = fromUserId;

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
      sessionStore.save(account.accountId, session);
    };

    const ctx: CommandContext = {
      accountId: account.accountId,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(account.accountId),
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      text: userText,
      listProjects: () => client.listProjects(),
      selectProject: (sessionId: string) => client.selectProject(sessionId),
      detachProject: () => client.detachProject(),
      getStatus: () => client.status(),
    };

    const result: CommandResult = await routeCommand(ctx);

    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      // /clear and /new must also clear the real DSH session (and its persisted
      // id mapping), even when the daemon is idle and not just mid-turn.
      if (/^\/(?:clear|new)(?:\s|$)/i.test(userText.trim())) {
        await client.clear(account.accountId).catch((err) => {
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
  session.state = 'processing';
  sessionStore.save(account.accountId, session);

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
      sessionId: account.accountId,
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, homedir()),
      model: session.model,
      systemPrompt: config.systemPrompt,
      files,
    });

    if (!accepted) {
      await sender.sendText(fromUserId, contextToken, '消息已收到，但 DSH 未接受处理请求。');
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      return;
    }

    // Stream the assistant response back.
    let finalText = '';
    let flushTimer: ReturnType<typeof setInterval> | undefined;
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    let pendingSend = '';
    let lastSentTime = Date.now();

    const flush = async (force: boolean): Promise<void> => {
      if (!pendingSend) return;
      const text = pendingSend;
      pendingSend = '';
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
      void flush(true).catch(() => {});
    }, 1500);

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
    await client.stream(account.accountId, (event: DshStreamEvent) => {
      switch (event.type) {
        case 'chunk':
          if (event.text) {
            finalText += event.text;
            pendingSend += event.text;
            // Batch streaming chunks into reasonably-sized WeChat messages;
            // flush immediately per-chunk would spam hundreds of tiny messages.
            if (pendingSend.length >= 1200) {
              void flush(false).catch(() => {});
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
          // Wait for the next stream tick to flush the remaining buffer.
          break;
      }
    }, controller.signal);

    if (flushTimer) clearInterval(flushTimer);
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    await flush(true);

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
    sessionStore.save(account.accountId, session);
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
