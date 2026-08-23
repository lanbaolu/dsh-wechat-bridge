import { loadJson, saveJson, validateAccountId } from './store.js';
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { DATA_DIR, DEFAULT_WORKING_DIR } from './constants.js';
import { join } from 'node:path';
import { logger } from './logger.js';
import { makeSessionFileStem, makeSessionKey, migrateLegacySessionKey } from './session-key.js';

const SESSIONS_DIR = join(DATA_DIR, 'sessions');

export type SessionState = 'idle' | 'processing';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface Session {
  sdkSessionId?: string;
  previousSdkSessionId?: string;
  workingDirectory: string;
  model?: string;
  state: SessionState;
  chatHistory: ChatMessage[];
  maxHistoryLength?: number;
}

const DEFAULT_MAX_HISTORY = 100;

export interface SessionStoreDeps {
  /** 当前 bot 账号的 accountId（用于多用户 key 前缀 + 旧数据迁移判定）。 */
  botAccountId: string;
  /** owner userId；用于把旧 ${accountId}.json 文件一次性迁移为 ${accountId}__${owner}.json。 */
  ownerUserId: string;
  /** 新会话默认工作目录（一般取 config.workingDirectory），缺省用 ~/Documents/DSH。 */
  defaultWorkingDirectory?: string;
}

/** 旧单用户时代的会话文件名（不带 '::'）—— 仅在迁移阶段使用。 */
function legacyStem(botAccountId: string): string {
  validateAccountId(botAccountId);
  return botAccountId;
}

export function createSessionStore(deps: SessionStoreDeps) {
  const { botAccountId, ownerUserId } = deps;
  const defaultWorkingDirectory = deps.defaultWorkingDirectory || DEFAULT_WORKING_DIR;
  validateAccountId(botAccountId);

  function stemForUser(userId: string): string {
    return makeSessionFileStem(botAccountId, userId);
  }

  function pathForStem(stem: string): string {
    return join(SESSIONS_DIR, `${stem}.json`);
  }

  function getSessionPath(userId: string): string {
    return pathForStem(stemForUser(userId));
  }

  function defaultSession(): Session {
    return {
      workingDirectory: defaultWorkingDirectory,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: DEFAULT_MAX_HISTORY,
    };
  }

  /**
   * 旧单用户数据迁移：${accountId}.json → ${accountId}__${ownerUserId}.json。
   * 升级到多用户时，owner 自己的历史会话必须保留为新 key；其他 key 不动。
   * 失败时保留旧文件不动（绝不丢历史）。
   */
  function migrateLegacyIfNeeded(): void {
    if (!ownerUserId) return;
    const oldPath = pathForStem(legacyStem(botAccountId));
    let newPath: string;
    try {
      const migrated = migrateLegacySessionKey(oldPath, botAccountId, ownerUserId);
      if (!migrated) return;
      newPath = migrated.newPath;
    } catch (err) {
      logger.warn('legacy session key migration rejected unsafe userId', { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (oldPath === newPath) return;
    try {
      const oldStat = statSync(oldPath);
      if (!oldStat.isFile()) return;
      // 若新文件已存在（owner 已被其他来源新建过会话），保留两边并留痕，绝不覆盖。
      try {
        statSync(newPath);
        logger.info('legacy session migration skipped: new key already has data', { oldPath, newPath });
        return;
      } catch {
        // newPath 不存在 → 继续迁移
      }
      renameSync(oldPath, newPath);
      logger.info('legacy session migrated to per-user key', { oldPath, newPath });
    } catch {
      // 旧文件不存在 / 不可访问 —— 无事可做，常见于首次启动
    }
  }

  function load(userId: string): Session {
    if (!userId) throw new Error('userId is required for per-user session');
    const session = loadJson<Session>(getSessionPath(userId), defaultSession());

    // Backward compatibility: ensure chatHistory exists
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    if (!session.maxHistoryLength) {
      session.maxHistoryLength = DEFAULT_MAX_HISTORY;
    }

    return session;
  }

  function save(userId: string, session: Session): void {
    mkdirSync(SESSIONS_DIR, { recursive: true });

    // Trim chat history if it exceeds max length before saving
    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }

    saveJson(getSessionPath(userId), session);
  }

  function clear(userId: string, currentSession?: Session): Session {
    const session: Session = {
      sdkSessionId: undefined,          // explicitly clear so Object.assign removes it
      previousSdkSessionId: undefined,
      workingDirectory: currentSession?.workingDirectory ?? defaultWorkingDirectory,
      model: currentSession?.model,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: currentSession?.maxHistoryLength || DEFAULT_MAX_HISTORY,
    };
    save(userId, session);
    return session;
  }

  function addChatMessage(session: Session, role: 'user' | 'assistant', content: string): void {
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    session.chatHistory.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // Trim if exceeds max length
    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }
  }

  function getChatHistoryText(session: Session, limit?: number): string {
    const history = session.chatHistory || [];
    const messages = limit ? history.slice(-limit) : history;

    if (messages.length === 0) {
      return '暂无对话记录';
    }

    const lines: string[] = [];
    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleString('zh-CN');
      const role = msg.role === 'user' ? '用户' : 'DSH';
      lines.push(`[${time}] ${role}:`);
      lines.push(msg.content);
      lines.push('');
    }

    return lines.join('\n');
  }

  // 暴露迁移与 key 工具，方便 main.ts 集中调用一次。
  function runMigrations(): void {
    migrateLegacyIfNeeded();
  }

  /**
   * 启动时把本 bot 所有会话的陈旧 'processing' 状态重置为 'idle'（崩溃恢复）。
   * 旧单用户版本只对一份会话做这件事；多用户版本要覆盖 ${accountId}__*.json。
   */
  function resetStaleStates(): void {
    try {
      const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        const stem = f.slice(0, -'.json'.length);
        if (stem !== botAccountId && !stem.startsWith(`${botAccountId}__`)) continue;
        const full = join(SESSIONS_DIR, f);
        const session = loadJson<Session>(full, defaultSession());
        if (session.state !== 'idle') {
          logger.warn('Resetting stale session state on startup', { file: f, state: session.state });
          session.state = 'idle';
          saveJson(full, session);
        }
      }
    } catch {
      // 目录不存在等情况无需处理
    }
  }

  /** 暴露运行时 session key（供 host 侧 /approval、/stream 等接口同源使用）。 */
  function keyFor(userId: string): string {
    return makeSessionKey(botAccountId, userId);
  }

  return { load, save, clear, addChatMessage, getChatHistoryText, runMigrations, resetStaleStates, keyFor };
}
