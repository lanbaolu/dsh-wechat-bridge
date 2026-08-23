import type { Session } from '../session.js';
import type { DshProjectSession } from '../dsh-client.js';
import { logger } from '../logger.js';
import { handleHelp, handleClear, handleNew, handleCwd, handleModel, handleStatus, handleHistory, handleReset, handleUndo, handleVersion, handlePrompt, handleSend, handleSession, handleSessionList, handleTrust, handleDistrust, handleTrustList, handleTrustMode, handleUnknown } from './handlers.js';
import type { TrustFile, TrustMode } from '../trust.js';

export interface CommandContext {
  accountId: string;
  /** 当前消息发送者 userId（多用户支持 P1-2 / M1：用于 trust 判定）。 */
  fromUserId?: string;
  /** 绑定账号的 owner userId。 */
  ownerUserId?: string;
  session: Session;
  updateSession: (partial: Partial<Session>) => void;
  clearSession: () => Session;
  getChatHistoryText?: (limit?: number) => string;
  text: string;
  listProjects?: () => Promise<DshProjectSession[]>;
  selectProject?: (sessionId: string) => Promise<Record<string, unknown>>;
  detachProject?: () => Promise<Record<string, unknown>>;
  getStatus?: () => Promise<Record<string, unknown>>;
  /** 信任集相关钩子（owner-only 模式不会注入）。 */
  trust?: {
    load(): TrustFile;
    save(file: TrustFile): void;
    listModeLabel(): string;
  };
}

export interface CommandResult {
  reply?: string;
  handled: boolean;
  dshPrompt?: string;
  sendFile?: string; // Absolute path to a file to send to the user
  /** 命令期望的 trustMode 变更（main 负责写入 trust.json——信任集唯一真相源）。 */
  setTrustMode?: TrustMode;
}

/**
 * Parse and dispatch a slash command.
 *
 * Supported commands:
 *   /help     - Show help text with all available commands
 *   /clear    - Clear the current session
 *   /model <name> - Update the session model
 *   /status   - Show current session info
 *   /history  - Show recent conversation history
 */
export async function routeCommand(ctx: CommandContext): Promise<CommandResult> {
  const text = ctx.text.trim();

  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const spaceIdx = text.indexOf(' ');
  const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  logger.info(`Slash command: /${cmd} ${args}`.trimEnd());

  switch (cmd) {
    case 'help':
      return handleHelp(args);
    case 'clear':
      return handleClear(ctx);
    case 'new':
      return handleNew(ctx);
    case 'reset':
      return handleReset(ctx);
    case 'cwd':
      return handleCwd(ctx, args);
    case 'model':
      return handleModel(ctx, args);
    case 'prompt':
      return handlePrompt(ctx, args);
    case 'status':
      return handleStatus(ctx);
    case 'history':
      return handleHistory(ctx, args);
    case 'undo':
      return handleUndo(ctx, args);
    case 'send':
      return handleSend(ctx, args);
    case 'sessionlist':
    case 'sessions':
    case 'projects':
      return handleSessionList(ctx);
    case 'session':
      return handleSession(ctx, args);
    case 'trust':
      return handleTrust(ctx, args);
    case 'distrust':
    case 'untrust':
      return handleDistrust(ctx, args);
    case 'trustlist':
    case 'trusts':
      return handleTrustList(ctx);
    case 'trustmode':
      return handleTrustMode(ctx, args);
    case 'version':
    case 'v':
      return handleVersion();
    default:
      return handleUnknown(cmd, args);
  }
}
