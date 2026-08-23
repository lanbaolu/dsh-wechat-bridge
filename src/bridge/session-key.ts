/**
 * 多用户支持 P1-2 / M2 — session key 构造与文件系统安全化。
 *
 * 单一真相：每条"活跃微信用户 ↔ DSH 会话"映射都收口到这里。
 *  - bot accountId（iLink 微信 bot userId） + 真实微信 userId → ${accountId}::${userId}
 *  - 文件名化：'::' 替换为 '__'，并对 userId 做字符白名单（仅 [A-Za-z0-9_.-@=]）。
 *  - 旧单用户时代（key = accountId）数据通过 migrateLegacySessionKey 改名为新 key。
 */
import { validateAccountId } from './store.js';

const SEP = '::';
const FILE_SEP = '__';

/** 字符白名单：避免路径穿越或不可移植字符。 */
function sanitizeUserIdForFs(userId: string): string {
  if (!/^[A-Za-z0-9_.\-@=]+$/.test(userId)) {
    throw new Error(`Unsafe userId for filesystem key: ${JSON.stringify(userId)}`);
  }
  return userId;
}

/** 构造运行时 session key（用于 Map、daemon 内部状态、approval/stream key）。 */
export function makeSessionKey(botAccountId: string, userId: string): string {
  validateAccountId(botAccountId);
  if (!userId) throw new Error('userId is required for per-user session key');
  return `${botAccountId}${SEP}${sanitizeUserIdForFs(userId)}`;
}

/** 构造文件名：${botAccountId}__${userId}.json（双下划线避免碰撞）。 */
export function makeSessionFileStem(botAccountId: string, userId: string): string {
  validateAccountId(botAccountId);
  if (!userId) throw new Error('userId is required for per-user session file');
  return `${botAccountId}${FILE_SEP}${sanitizeUserIdForFs(userId)}`;
}

/** 从 key 中拆出 botAccountId / userId（运行时 key 含 '::'，文件名含 '__'）。 */
export function parseSessionKey(key: string): { botAccountId: string; userId: string } | null {
  if (!key) return null;
  const sepIdx = key.indexOf(SEP);
  if (sepIdx === -1) {
    // 旧单用户 key：userId = key 自身（不一定是合法 userId，但保持原值以兼容）
    return { botAccountId: key, userId: '' };
  }
  return { botAccountId: key.slice(0, sepIdx), userId: key.slice(sepIdx + SEP.length) };
}

/** 给定一个旧 session 路径与已知 owner userId，迁移到新文件名；返回新路径。 */
export function migrateLegacySessionKey(
  oldPath: string,
  botAccountId: string,
  ownerUserId: string,
): { newPath: string; newKey: string } | null {
  if (!ownerUserId) return null;
  try {
    sanitizeUserIdForFs(ownerUserId);
  } catch {
    return null;
  }
  const newStem = makeSessionFileStem(botAccountId, ownerUserId);
  const dir = oldPath.replace(/[\\/][^\\/]+$/, '');
  const ext = '.json';
  return {
    newPath: `${dir}/${newStem}${ext}`,
    newKey: makeSessionKey(botAccountId, ownerUserId),
  };
}
