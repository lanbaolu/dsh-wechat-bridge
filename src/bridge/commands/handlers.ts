import type { CommandContext, CommandResult } from './router.js';
import type { DshProjectSession } from '../dsh-client.js';
import { loadConfig, saveConfig } from '../config.js';
import { DEFAULT_WORKING_DIR } from '../constants.js';
import { isPlausibleUserId, addTrusted, removeTrusted, listTrusted } from '../trust.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HELP_TEXT = `可用命令：

会话管理：
  /help             显示帮助
  /stop             停止当前对话并清空排队消息
  /yes              批准 DSH 的权限请求（审批超时自动拒绝）
  /no               拒绝 DSH 的权限请求
  /clear            清除当前会话并开启新会话
  /new              开启全新会话（等价 /clear）
  /reset            完全重置（包括工作目录等设置）
  /status           查看当前会话状态
  /history [数量]   查看对话记录（默认最近20条）
  /undo [数量]      撤销最近对话（默认1条）

文件：
  /send <路径>      发送本地文件（图片直接显示，其他文件作为附件）

配置：
  /cwd [路径]       查看或切换工作目录
  /model [名称]     查看或切换模型
  /prompt [内容]    查看或设置系统提示词（全局生效）

多用户信任（仅 owner 可见）：
  /trust <userId> [备注]  添加一个信任用户（手动模式生效）
  /distrust <userId>      吊销一个信任用户
  /trustlist              查看当前信任集
  /trustmode [owner-only|bootstrap|manual]  查看或切换信任模式

项目绑定：
  /sessionlist      列出可绑定的 DSH 项目会话
  /session [序号|ID|off]  绑定项目会话 / 查看当前 / 解除绑定

其他：
  /version          查看版本信息

直接输入文字即可与 DSH 对话`;

export function handleHelp(_args: string): CommandResult {
  return { reply: HELP_TEXT, handled: true };
}

export function handleClear(ctx: CommandContext): CommandResult {
  const newSession = ctx.clearSession();
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已清除，下次消息将开始新会话。', handled: true };
}

/** Alias for /clear, matching the common “/new opens a fresh session” convention. */
export function handleNew(ctx: CommandContext): CommandResult {
  return handleClear(ctx);
}

export function handleCwd(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: `当前工作目录: ${ctx.session.workingDirectory}\n用法: /cwd <路径>`, handled: true };
  }
  ctx.updateSession({ workingDirectory: args });
  return { reply: `✅ 工作目录已切换为: ${args}`, handled: true };
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /model <模型名称>\n例: /model deepseek-v4-flash', handled: true };
  }
  ctx.updateSession({ model: args });
  return { reply: `✅ 模型已切换为: ${args}`, handled: true };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const s = ctx.session;
  const lines = [
    '📊 会话状态',
    '',
    `工作目录: ${s.workingDirectory}`,
    `模型: ${s.model ?? '默认'}`,
    `状态: ${s.state}`,
  ];
  return { reply: lines.join('\n'), handled: true };
}

const MAX_HISTORY_LIMIT = 100;

export function handleHistory(ctx: CommandContext, args: string): CommandResult {
  const limit = args ? parseInt(args, 10) : 20;
  if (isNaN(limit) || limit <= 0) {
    return { reply: '用法: /history [数量]\n例: /history 50（显示最近50条对话）', handled: true };
  }
  const effectiveLimit = Math.min(limit, MAX_HISTORY_LIMIT);

  const historyText = ctx.getChatHistoryText?.(effectiveLimit) || '暂无对话记录';

  return { reply: `📝 对话记录（最近${effectiveLimit}条）:\n\n${historyText}`, handled: true };
}

/** 完全重置会话（包括工作目录等设置） */
export function handleReset(ctx: CommandContext): CommandResult {
  const newSession = ctx.clearSession();
  newSession.workingDirectory = DEFAULT_WORKING_DIR;
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已完全重置，所有设置恢复默认。', handled: true };
}

/** 撤销最近 N 条对话 */
export function handleUndo(ctx: CommandContext, args: string): CommandResult {
  const count = args ? parseInt(args, 10) : 1;
  if (isNaN(count) || count <= 0) {
    return { reply: '用法: /undo [数量]\n例: /undo 2（撤销最近2条对话）', handled: true };
  }
  const history = ctx.session.chatHistory || [];
  if (history.length === 0) {
    return { reply: '⚠️ 没有对话记录可撤销', handled: true };
  }
  const actualCount = Math.min(count, history.length);
  ctx.session.chatHistory = history.slice(0, -actualCount);
  ctx.updateSession({ chatHistory: ctx.session.chatHistory });
  return { reply: `✅ 已撤销最近 ${actualCount} 条对话`, handled: true };
}

/** 查看版本信息 */
export function handleVersion(): CommandResult {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'));
    const version = pkg.version || 'unknown';
    return { reply: `dsh-wechat-bridge v${version}`, handled: true };
  } catch {
    return { reply: 'dsh-wechat-bridge (version unknown)', handled: true };
  }
}

export function handlePrompt(_ctx: CommandContext, args: string): CommandResult {
  const config = loadConfig();
  if (!args) {
    const current = config.systemPrompt;
    if (current) {
      return { reply: `📝 当前系统提示词:\n${current}\n\n用法:\n/prompt <提示词>  — 设置\n/prompt clear   — 清除`, handled: true };
    }
    return { reply: '📝 暂无系统提示词\n\n用法: /prompt <提示词>\n例: /prompt 用中文回答我', handled: true };
  }
  if (args.trim().toLowerCase() === 'clear') {
    config.systemPrompt = undefined;
    saveConfig(config);
    return { reply: '✅ 系统提示词已清除', handled: true };
  }
  config.systemPrompt = args.trim();
  saveConfig(config);
  return { reply: `✅ 系统提示词已设置:\n${config.systemPrompt}`, handled: true };
}

export function handleSend(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /send <文件路径>\n例: /send ~/Documents/report.pdf\n     /send ./chart.png', handled: true };
  }

  const resolved = args.startsWith('/')
    ? args
    : resolve(ctx.session.workingDirectory, args.replace(/^~/, homedir()));
  if (!existsSync(resolved)) {
    return { reply: `文件不存在: ${resolved}`, handled: true };
  }

  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    return { reply: `这是一个目录，请指定文件: ${resolved}`, handled: true };
  }

  if (stat.size > 25 * 1024 * 1024) {
    return { reply: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 25MB`, handled: true };
  }

  return { handled: true, sendFile: resolved };
}

function formatProjectLine(project: DshProjectSession, index: number): string {
  return `${index + 1}. ${project.workspaceTitle} · ${project.path} · ${project.sessionId.slice(-8)}`;
}

export async function handleSessionList(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.listProjects) {
    return { reply: '当前守护进程不支持项目会话列表（请升级插件并重启桥接）。', handled: true };
  }
  try {
    const projects = await ctx.listProjects();
    if (projects.length === 0) {
      return { reply: '没有可绑定的项目会话。\n请先在 DSH Web 端创建/打开一个项目对话。', handled: true };
    }
    const lines = projects.map(formatProjectLine);
    return {
      reply: `📁 可绑定项目会话（共 ${projects.length} 个）:\n\n${lines.join('\n')}\n\n绑定：/session <序号或ID>\n解除：/session off`,
      handled: true,
    };
  } catch (err) {
    return { reply: `⚠️ 获取项目会话失败：${err instanceof Error ? err.message : String(err)}`, handled: true };
  }
}

export async function handleSession(ctx: CommandContext, args: string): Promise<CommandResult> {
  const arg = args.trim();

  if (!arg) {
    if (!ctx.getStatus) {
      return { reply: '用法: /session <序号或ID>\n查看列表: /sessionlist', handled: true };
    }
    try {
      const status = await ctx.getStatus();
      const selected = (status as { selectedProject?: { workspaceTitle?: string; path?: string; sessionId?: string } | null }).selectedProject;
      if (selected?.sessionId) {
        return {
          reply: `当前绑定：${selected.workspaceTitle || ''} · ${selected.path || ''} · ${selected.sessionId.slice(-8)}\n解除绑定：/session off`,
          handled: true,
        };
      }
      return { reply: '当前未绑定项目会话。\n查看列表：/sessionlist\n绑定：/session <序号或ID>', handled: true };
    } catch (err) {
      return { reply: `⚠️ 获取状态失败：${err instanceof Error ? err.message : String(err)}`, handled: true };
    }
  }

  const lower = arg.toLowerCase();
  if (lower === 'off' || lower === 'detach' || lower === 'unbind' || lower === '解除') {
    if (!ctx.detachProject) {
      return { reply: '当前守护进程不支持解除绑定。', handled: true };
    }
    try {
      const result = await ctx.detachProject();
      return {
        reply: `✅ 已解除项目会话绑定${result.daemon ? `（${result.daemon}）` : ''}`,
        handled: true,
      };
    } catch (err) {
      return { reply: `⚠️ 解除绑定失败：${err instanceof Error ? err.message : String(err)}`, handled: true };
    }
  }

  if (!ctx.listProjects || !ctx.selectProject) {
    return { reply: '当前守护进程不支持项目绑定（请升级插件并重启桥接）。', handled: true };
  }

  try {
    const projects = await ctx.listProjects();
    if (projects.length === 0) {
      return { reply: '没有可绑定的项目会话。', handled: true };
    }

    let target: DshProjectSession | undefined;
    if (/^\d+$/.test(arg)) {
      target = projects[parseInt(arg, 10) - 1];
    } else {
      target = projects.find((p) =>
        p.sessionId === arg
        || p.sessionId.endsWith(arg)
        || p.workspaceTitle === arg
        || p.path.includes(arg),
      );
    }

    if (!target) {
      return { reply: `未找到匹配的项目会话：${arg}\n查看列表：/sessionlist`, handled: true };
    }

    const result = await ctx.selectProject(target.sessionId);
    return {
      reply: `✅ 已绑定项目会话：${target.workspaceTitle} · ${target.path}${result.daemon ? `\n${result.daemon}` : ''}`,
      handled: true,
    };
  } catch (err) {
    return { reply: `⚠️ 绑定失败：${err instanceof Error ? err.message : String(err)}`, handled: true };
  }
}

export function handleUnknown(cmd: string, _args: string): CommandResult {
  return {
    handled: true,
    reply: `未识别命令: /${cmd}\n输入 /help 查看可用命令`,
  };
}

// ---------------------------------------------------------------------------
// 多用户信任集（P1-2 / M1）
// ---------------------------------------------------------------------------

/**
 * owner 专属：把 userId 加入信任集。
 * - 当前模式非 manual 时只提示启用方法（bootstrap 模式自动拉人，无需手动加）。
 * - 加自己无效；userId 形态校验失败直接拒绝。
 */
export function handleTrust(ctx: CommandContext, args: string): CommandResult {
  if (!ctx.trust) {
    return { reply: '当前为 owner-only 模式，不需要手动添加信任用户。\n要放开多人对话，请先用 /trustmode 切换到 bootstrap 或 manual。', handled: true };
  }
  const ownerId = ctx.ownerUserId;
  if (ownerId && ctx.fromUserId && ctx.fromUserId !== ownerId) {
    return { reply: '⚠️ /trust 仅 owner 可用（信任集管理权限）。', handled: true };
  }
  const arg = args.trim();
  if (!arg) {
    return { reply: '用法: /trust <userId> [备注]\n例: /trust wxid_abc 老婆\n  /trustlist 查看当前信任集', handled: true };
  }
  const firstSpace = arg.search(/\s/);
  const userId = (firstSpace === -1 ? arg : arg.slice(0, firstSpace)).trim();
  const note = (firstSpace === -1 ? '' : arg.slice(firstSpace + 1).trim()) || undefined;
  if (userId === ownerId) {
    return { reply: 'ℹ️ owner 永远放行，不需要把自己加入信任集。', handled: true };
  }
  if (!isPlausibleUserId(userId)) {
    return { reply: '⚠️ userId 格式不合法（应为 4-64 位字母/数字/_ . @ = -）。', handled: true };
  }
  const file = ctx.trust.load();
  const next = addTrusted(file, userId, 'owner', note);
  ctx.trust.save(next);
  return {
    reply: `✅ 已添加信任用户：${userId}${note ? `（${note}）` : ''}\n当前模式：${ctx.trust.listModeLabel()}\n（手动模式才会拦截陌生人；bootstrap 模式首位陌生人会自动入集，无需 /trust。）`,
    handled: true,
  };
}

/** owner 专属：从信任集移除 userId。 */
export function handleDistrust(ctx: CommandContext, args: string): CommandResult {
  if (!ctx.trust) {
    return { reply: '当前为 owner-only 模式，没有信任集可管理。', handled: true };
  }
  const ownerId = ctx.ownerUserId;
  if (ownerId && ctx.fromUserId && ctx.fromUserId !== ownerId) {
    return { reply: '⚠️ /distrust 仅 owner 可用。', handled: true };
  }
  const userId = args.trim();
  if (!userId) {
    return { reply: '用法: /distrust <userId>\n查看列表：/trustlist', handled: true };
  }
  if (!isPlausibleUserId(userId)) {
    return { reply: '⚠️ userId 格式不合法。', handled: true };
  }
  const file = ctx.trust.load();
  if (!file.trusted[userId]) {
    return { reply: `ℹ️ ${userId} 不在信任集中。\n查看列表：/trustlist`, handled: true };
  }
  const next = removeTrusted(file, userId);
  ctx.trust.save(next);
  return { reply: `✅ 已吊销：${userId}（后续消息会被拒绝，已存在的会话保留只读）`, handled: true };
}

/** owner 专属：列出当前 trustMode + 信任集。 */
export function handleTrustList(ctx: CommandContext): CommandResult {
  if (!ctx.trust) {
    return { reply: '当前模式：owner-only（仅本机账号主人本人）\n要放开多人对话：/trustmode bootstrap|manual', handled: true };
  }
  const ownerId = ctx.ownerUserId;
  if (ownerId && ctx.fromUserId && ctx.fromUserId !== ownerId) {
    return { reply: '⚠️ /trustlist 仅 owner 可用。', handled: true };
  }
  const file = ctx.trust.load();
  const rows = listTrusted(file);
  const lines = [
    `🔐 信任模式：${ctx.trust.listModeLabel()}`,
    `owner：${ownerId || '（未绑定）'}`,
    `信任用户：${rows.length} 个`,
  ];
  if (rows.length > 0) {
    lines.push('');
    for (const r of rows) {
      const added = new Date(r.addedAt).toLocaleString('zh-CN');
      const seen = r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString('zh-CN') : '从未活跃';
      const note = r.note ? ` · ${r.note}` : '';
      lines.push(`- ${r.userId}（添加于 ${added} · 最近 ${seen}${note}）`);
    }
  }
  lines.push('');
  lines.push('管理：/trust <userId> [备注] · /distrust <userId> · /trustmode [模式]');
  return { reply: lines.join('\n'), handled: true };
}

/** owner 专属：查看或切换 trustMode。 */
export function handleTrustMode(ctx: CommandContext, args: string): CommandResult {
  const ownerId = ctx.ownerUserId;
  if (ownerId && ctx.fromUserId && ctx.fromUserId !== ownerId) {
    return { reply: '⚠️ /trustmode 仅 owner 可用。', handled: true };
  }
  const arg = args.trim().toLowerCase();
  if (!arg) {
    return {
      reply: `当前信任模式：${ctx.trust ? ctx.trust.listModeLabel() : 'owner-only'}\n\n可选：\n  owner-only  仅本机主人（默认，单用户行为）\n  bootstrap    首位陌生人自动入集（一次性）\n  manual       仅 /trust 添加的人\n\n切换：/trustmode <模式>`,
      handled: true,
    };
  }
  if (arg !== 'owner-only' && arg !== 'bootstrap' && arg !== 'manual') {
    return { reply: '⚠️ 模式必须是 owner-only / bootstrap / manual。', handled: true };
  }
  return {
    reply: `✅ 信任模式已切换为：${arg}（立即生效，后续入站消息按新模式判定）`,
    handled: true,
    setTrustMode: arg,
  };
}
