import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';

/**
 * 主动通知节流队列。
 *
 * 微信个人号协议对「主动高频消息 / 固定时间批量推送 / 模板化重复文案」高度敏感：
 * 机器人主动发消息（agent 先发）比「你发我回」的被动回复更容易触发风控。
 * 这里用 频率窗口 + 每日配额 + 随机抖动 + 队列排队 的组合把主动通知的突刺打散：
 * 宁可延迟发送，也不集中突刺。
 */

export interface NotifyThrottleConfig {
  /** 每小时最大主动通知条数。 */
  hourlyLimit: number;
  /** 每日（自然日）最大主动通知条数。 */
  dailyLimit: number;
  /** 相邻两条主动通知的最小发送间隔（毫秒）。 */
  minIntervalMs: number;
  /** 发送前随机延迟区间 [min, max]（毫秒），打散固定节奏。 */
  jitterMs: [number, number];
  /** 排队容量；超出时丢弃最旧的通知（最新通知优先）。 */
  queueCapacity: number;
}

export const DEFAULT_NOTIFY_CONFIG: NotifyThrottleConfig = {
  hourlyLimit: 6,
  dailyLimit: 50,
  minIntervalMs: 60_000,
  jitterMs: [10_000, 30_000],
  queueCapacity: 20,
};

export interface NotifyEnqueueResult {
  accepted: boolean;
  /** 未接受 / 受限时的原因。 */
  reason?: 'invalid' | 'queue-full';
  /** 预计延迟秒数（受限排队后）。 */
  delaySec?: number;
  /** 当前排队条数（不含已发送）。 */
  queued: number;
}

/**
 * 轮换前缀池：不改变语义的符号前缀，打散「完全一致文案重复推送」的模板特征。
 * 空串占比最高，避免每条通知都带符号。
 */
const PREFIX_POOL = ['', '', '📌 ', '🔔 ', '✨ '];

const MAX_NOTIFY_LENGTH = 4000;
const HOUR_MS = 60 * 60 * 1000;

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface DailyCountEntry {
  date: string;
  count: number;
}

function loadDailyCount(): DailyCountEntry {
  const path = join(DATA_DIR, 'notify-stats.json');
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<DailyCountEntry>;
    return { date: String(raw.date || ''), count: Number(raw.count) || 0 };
  } catch {
    return { date: '', count: 0 };
  }
}

function saveDailyCount(entry: DailyCountEntry): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, 'notify-stats.json'), JSON.stringify(entry, null, 2) + '\n', 'utf8');
  } catch (err) {
    logger.warn('Failed to persist notify stats', { error: err instanceof Error ? err.message : String(err) });
  }
}

export interface NotifyStatus {
  /** 今日（自然日）已发送条数。 */
  dailySent: number;
  dailyLimit: number;
  /** 近一小时已发送条数。 */
  hourlySent: number;
  hourlyLimit: number;
  /** 当前排队条数。 */
  pendingCount: number;
  queueCapacity: number;
}

export interface NotifyThrottle {
  /** 入队一条主动通知。 */
  enqueue(message: string): NotifyEnqueueResult;
  /** 当前排队条数。 */
  readonly pendingCount: number;
  /** 当前节流状态快照（供 Web 面板 / 状态工具展示）。 */
  getStatus(): NotifyStatus;
  /** 停止定时器（daemon 退出时调用）。 */
  stop(): void;
}

export function createNotifyThrottle(
  send: (message: string) => Promise<void>,
  config: NotifyThrottleConfig = DEFAULT_NOTIFY_CONFIG,
): NotifyThrottle {
  /** 最近一小时内的发送时间戳（rolling window）。 */
  const hourlyWindow: number[] = [];
  let daily = loadDailyCount();
  let lastSentAt = 0;
  const queue: string[] = [];
  let flushing = false;

  function now(): number {
    return Date.now();
  }

  function pruneHourly(): void {
    const cutoff = now() - HOUR_MS;
    while (hourlyWindow.length > 0 && hourlyWindow[0] < cutoff) hourlyWindow.shift();
  }

  function hourlyCount(): number {
    pruneHourly();
    return hourlyWindow.length;
  }

  function dailyCount(): number {
    const key = dayKey(new Date());
    if (daily.date !== key) {
      daily = { date: key, count: 0 };
      saveDailyCount(daily);
    }
    return daily.count;
  }

  function recordSent(): void {
    hourlyWindow.push(now());
    const key = dayKey(new Date());
    if (daily.date !== key) daily = { date: key, count: 0 };
    daily.count += 1;
    saveDailyCount(daily);
  }

  function pickPrefix(): string {
    return PREFIX_POOL[Math.floor(Math.random() * PREFIX_POOL.length)];
  }

  function randomJitter(): number {
    const [min, max] = config.jitterMs;
    return min + Math.floor(Math.random() * (max - min));
  }

  function canSendNow(): boolean {
    if (hourlyCount() >= config.hourlyLimit) return false;
    if (dailyCount() >= config.dailyLimit) return false;
    if (now() - lastSentAt < config.minIntervalMs) return false;
    return true;
  }

  function markSent(): void {
    lastSentAt = now();
    recordSent();
  }

  async function sendOne(message: string): Promise<void> {
    // 随机延迟抖动：打散固定节奏，避免「整点 / 固定间隔」的机器特征。
    await new Promise((resolve) => setTimeout(resolve, randomJitter()));
    try {
      await send(pickPrefix() + message);
      markSent();
      logger.info('Proactive notification sent', { textLength: message.length });
    } catch (err) {
      // 发送失败不重试：避免在风控边缘反复试探；下一条按正常节奏走。
      logger.warn('Proactive notification send failed (not retried)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function flushLoop(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      // 每次把「当前配额内可发送」的队首依次发出；超限时保留队列等下一个窗口。
      while (queue.length > 0) {
        if (!canSendNow()) break;
        const message = queue.shift()!;
        await sendOne(message);
      }
    } finally {
      flushing = false;
    }
  }

  const timer = setInterval(() => {
    void flushLoop().catch(() => {});
  }, 15_000);
  timer.unref?.();

  return {
    enqueue(message: string): NotifyEnqueueResult {
      const text = typeof message === 'string' ? message.trim() : '';
      if (!text) return { accepted: false, reason: 'invalid', queued: queue.length };
      const clipped = text.length > MAX_NOTIFY_LENGTH ? text.slice(0, MAX_NOTIFY_LENGTH) : text;

      if (queue.length >= config.queueCapacity) {
        // 队列满：丢弃最旧的（事件通知越新越重要），新通知照常入队。
        queue.shift();
        queue.push(clipped);
        const result: NotifyEnqueueResult = { accepted: true, reason: 'queue-full', queued: queue.length };
        if (!canSendNow()) result.delaySec = 15 + Math.ceil(randomJitter() / 1000);
        void flushLoop().catch(() => {});
        return result;
      }

      queue.push(clipped);
      const result: NotifyEnqueueResult = { accepted: true, queued: queue.length };
      if (!canSendNow()) {
        // 受限（窗口/配额/间隔未过）：告诉调用方预计延迟，避免对方以为已发出。
        result.delaySec = 15 + Math.ceil(randomJitter() / 1000);
      }
      void flushLoop().catch(() => {});
      return result;
    },
    get pendingCount(): number {
      return queue.length;
    },
    getStatus(): NotifyStatus {
      return {
        dailySent: dailyCount(),
        dailyLimit: config.dailyLimit,
        hourlySent: hourlyCount(),
        hourlyLimit: config.hourlyLimit,
        pendingCount: queue.length,
        queueCapacity: config.queueCapacity,
      };
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}
