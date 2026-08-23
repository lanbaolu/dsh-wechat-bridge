/**
 * 信任集（多用户支持 P1-2 / M1）。
 *
 * iLink 微信协议扫码绑定的是「bot 自身」账号（不是用户），所以"多用户"的边界
 * 必须在协议层之上划：把可信微信用户的 `from_user_id` 加进信任集，放行/拒绝入站。
 *
 * 三种模式（fail-closed 默认）：
 *   - owner-only   : 只认账号绑定者本人，与单用户时代完全一致，零行为变化
 *   - bootstrap    : 首个联系的陌生人自动入信任集（一次性触发）
 *   - manual       : 仅 owner 显式 /trust 添加的人
 *
 * 陌生人尝试联系时只记日志（不回复）——可选 `notifyRejected: true` 时给 owner
 * 推一条提示，规避偷偷联系的行为。
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';

export type TrustMode = 'owner-only' | 'bootstrap' | 'manual';

export interface TrustedEntry {
  /** ISO 字符串，由 owner 显式或 bootstrap 自动添加的时间。 */
  addedAt: string;
  /** 添加来源描述：'owner' | 'bootstrap' | 'restore'（迁移用）。 */
  by: 'owner' | 'bootstrap' | 'restore';
  /** 最近一次收到该用户消息的 epoch 毫秒（用于面板「最近活跃」展示）。 */
  lastSeenAt?: number;
  /** 备注（可选），owner /trust <userId> [备注] 时记录。 */
  note?: string;
}

export interface TrustFile {
  mode: TrustMode;
  /** 当前生效的信任用户集（owner 不在此列——owner 永远放行，单独走 account.userId）。 */
  trusted: Record<string, TrustedEntry>;
  /** bootstrap 模式下已被使用过——只触发一次，防止反复自动拉陌生人。 */
  bootstrapConsumed?: boolean;
}

const TRUST_PATH = join(DATA_DIR, 'trust.json');
const FILE_MODE = 0o600;

const DEFAULT_FILE: TrustFile = {
  mode: 'owner-only',
  trusted: {},
};

/** 加载 trust.json，损坏文件留证后退回默认（owner-only）。path 可覆盖（host 侧用自己的 dataDir）。 */
export function loadTrust(path: string = TRUST_PATH): TrustFile {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TrustFile>;
    const mode: TrustMode =
      parsed.mode === 'bootstrap' || parsed.mode === 'manual' || parsed.mode === 'owner-only'
        ? parsed.mode
        : 'owner-only';
    const trusted: Record<string, TrustedEntry> = {};
    if (parsed.trusted && typeof parsed.trusted === 'object') {
      for (const [k, v] of Object.entries(parsed.trusted)) {
        if (v && typeof v === 'object' && typeof (v as TrustedEntry).addedAt === 'string') {
          trusted[k] = v as TrustedEntry;
        }
      }
    }
    return {
      mode,
      trusted,
      bootstrapConsumed: parsed.bootstrapConsumed === true,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') {
      // 损坏文件隔离（与 store.loadJson 一致的策略）。
      try {
        const corruptPath = `${path}.corrupt-${Date.now()}`;
        renameSync(path, corruptPath);
        logger.warn('trust.json quarantined as corrupt, falling back to owner-only', {
          path: corruptPath,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch {
        logger.warn('trust.json load failed, falling back to owner-only', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { ...DEFAULT_FILE };
  }
}

/** 持久化 trust.json（0600 权限，避免敏感 userId 暴露给同机其他用户）。 */
export function saveTrust(file: TrustFile, path: string = TRUST_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', 'utf8');
  if (process.platform !== 'win32') {
    chmodSync(path, FILE_MODE);
  }
}

/**
 * 单条信任判定入口（纯函数 + 副作用小，方便单测）。
 *
 * 返回 `{ allowed, reason, decidedAs }`：
 *   - allowed: 消息是否放行
 *   - reason : 'owner' | 'trusted' | 'bootstrap-auto' | 'rejected-stranger'
 *   - decidedAs: 'pass' | 'auto-trust' | 'reject'
 *
 * 注意：本函数在 bootstrap 模式下会自动写入 trust，需要配合调用方把副作用落盘。
 * 为避免调用方遗漏，所有副作用在此一并执行并返回新的 file。
 */
export interface TrustDecision {
  allowed: boolean;
  reason: 'owner' | 'trusted' | 'bootstrap-auto' | 'rejected-stranger';
  /** 副作用后的 trust 文件（未变更时也返回引用）；调用方无需再写。 */
  file: TrustFile;
}

export interface DecideTrustInput {
  fromUserId: string;
  ownerUserId: string;
  file: TrustFile;
  /** 'manual' 模式下此参数无效（永不自动信任）。 */
  nowIso?: string;
}

export function decideTrust(input: DecideTrustInput): TrustDecision {
  const { fromUserId, ownerUserId, file } = input;
  if (!fromUserId) {
    return { allowed: false, reason: 'rejected-stranger', file };
  }
  if (ownerUserId && fromUserId === ownerUserId) {
    return { allowed: true, reason: 'owner', file };
  }
  if (file.trusted[fromUserId]) {
    // 刷新最近活跃时间。返回新对象（不清算原引用），调用方据此判定是否需要落盘。
    return {
      allowed: true,
      reason: 'trusted',
      file: {
        ...file,
        trusted: {
          ...file.trusted,
          [fromUserId]: {
            ...file.trusted[fromUserId],
            lastSeenAt: Date.now(),
          },
        },
      },
    };
  }
  if (file.mode === 'bootstrap' && !file.bootstrapConsumed) {
    // bootstrap 自动入集前校验 userId 形态：异常字符（含 `::`/空格等）会导致
    // 后续 sessionStore.keyFor 抛异常、消息被静默吞掉——直接拒绝而非自动入集。
    if (!isPlausibleUserId(fromUserId)) {
      logger.warn('bootstrap auto-trust skipped: unsafe userId', { fromUserId });
      return { allowed: false, reason: 'rejected-stranger', file };
    }
    const next: TrustFile = {
      ...file,
      bootstrapConsumed: true,
      trusted: {
        ...file.trusted,
        [fromUserId]: {
          addedAt: input.nowIso ?? new Date().toISOString(),
          by: 'bootstrap',
          lastSeenAt: Date.now(),
        },
      },
    };
    logger.info('bootstrap auto-trust', { fromUserId });
    return { allowed: true, reason: 'bootstrap-auto', file: next };
  }
  return { allowed: false, reason: 'rejected-stranger', file };
}

/** 添加 / 移除 trust 用户的纯函数封装（被 /trust /distrust 复用）。 */
export function addTrusted(file: TrustFile, userId: string, by: 'owner' | 'restore' = 'owner', note?: string): TrustFile {
  return {
    ...file,
    trusted: {
      ...file.trusted,
      [userId]: {
        addedAt: new Date().toISOString(),
        by,
        lastSeenAt: Date.now(),
        ...(note ? { note } : {}),
      },
    },
  };
}

export function removeTrusted(file: TrustFile, userId: string): TrustFile {
  if (!file.trusted[userId]) return file;
  const next = { ...file.trusted };
  delete next[userId];
  return { ...file, trusted: next };
}

export function setTrustMode(file: TrustFile, mode: TrustMode): TrustFile {
  return { ...file, mode };
}

/** owner 视角的信任集列表（用于 /trustlist 与面板展示）。 */
export interface TrustedView {
  userId: string;
  addedAt: string;
  by: 'owner' | 'bootstrap' | 'restore';
  lastSeenAt?: number;
  note?: string;
}

export function listTrusted(file: TrustFile): TrustedView[] {
  return Object.entries(file.trusted)
    .map(([userId, entry]) => ({ userId, ...entry }))
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
}

/** 用于 owner /trust 校验：userId 看起来像 iLink 微信 userId（防止误传垃圾）。 */
const USER_ID_PATTERN = /^[A-Za-z0-9_.@=-]{4,64}$/;
export function isPlausibleUserId(s: string): boolean {
  return USER_ID_PATTERN.test(s);
}
