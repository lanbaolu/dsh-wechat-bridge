import type {
  GetUpdatesResp,
  SendMessageReq,
  GetUploadUrlResp,
  SendTypingReq,
  GetConfigResp,
} from './types.js';
import { logger } from '../logger.js';

/** Generate a random base64 identifier. */
function generateUin(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64');
}

export class WeChatApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly uin: string;
  private readonly nextSendTime = new Map<string, number>();
  private static readonly MIN_SEND_INTERVAL = 2500;
  // Cooldown applied after a rate-limit (ret:-2). Aligned with the circuit
  // breaker window so they don't fight each other.
  private static readonly RATE_LIMIT_COOLDOWN_MS = 30_000;

  // ── Circuit breaker ────────────────────────────────────────────────────
  // Borrowed from Hermes WeChat adapter: trip after the first genuine
  // rate-limit in a 30s window, stay open 30s. While open, all sends fail
  // fast without hitting the API — breaking the 14-minute "head-banging"
  // loop we observed in production logs.
  private static readonly CIRCUIT_THRESHOLD = 1;
  private static readonly CIRCUIT_WINDOW_MS = 30_000;
  private static readonly CIRCUIT_OPEN_MS = 30_000;
  private readonly _rateLimitEvents: number[] = [];
  private _circuitUntil = 0;

  // ret:-2 + errmsg="unknown error" is a stale-session signal (same family
  // as errcode:-14), not a real rate-limit. Pause that user 10 minutes
  // instead of cycling through the rate-limit path.
  private static readonly STALE_SESSION_PAUSE_MS = 10 * 60 * 1000;

  constructor(token: string, baseUrl: string = 'https://ilinkai.weixin.qq.com') {
    if (baseUrl) {
      try {
        const url = new URL(baseUrl);
        const allowedHosts = ['weixin.qq.com', 'wechat.com'];
        const isAllowed = allowedHosts.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
        if (url.protocol !== 'https:' || !isAllowed) {
          logger.warn('Untrusted baseUrl, using default', { baseUrl });
          baseUrl = 'https://ilinkai.weixin.qq.com';
        }
      } catch {
        logger.warn('Invalid baseUrl, using default', { baseUrl });
        baseUrl = 'https://ilinkai.weixin.qq.com';
      }
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.uin = generateUin();
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.token}`,
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': this.uin,
    };
  }

  private async request<T = Record<string, unknown>>(
    path: string,
    body: unknown,
    timeoutMs: number = 15_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const url = `${this.baseUrl}/${path}`;

    logger.debug('API request', { url, body });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const json = (await res.json()) as T;
      logger.debug('API response', json);
      return json;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Long-poll for new messages. Timeout 35s for long-polling. */
  async getUpdates(buf?: string): Promise<GetUpdatesResp> {
    return this.request<GetUpdatesResp>(
      'ilink/bot/getupdates',
      buf ? { get_updates_buf: buf } : {},
      35_000,
    );
  }

  /** Send a message to a user. Per-user rate limited, retries on rate-limit (ret: -2). */
  async sendMessage(req: SendMessageReq): Promise<void> {
    // Circuit breaker: fail fast without calling the API while open.
    // This is what breaks the 14-minute head-banging loop.
    if (this._isCircuitOpen()) {
      const remainingSec = Math.ceil((this._circuitUntil - Date.now()) / 1000);
      logger.warn('sendMessage rejected by circuit breaker', { remainingSec });
      throw new Error(`circuit breaker open, ${remainingSec}s remaining`);
    }

    const userId = req.msg?.to_user_id;
    if (userId) {
      const now = Date.now();
      const nextAvailable = (this.nextSendTime.get(userId) ?? 0) + WeChatApi.MIN_SEND_INTERVAL;
      const sendAt = Math.max(now, nextAvailable);
      this.nextSendTime.set(userId, sendAt);
      const waitMs = sendAt - now;
      if (waitMs > 0) {
        logger.debug('Rate limiter waiting', { userId, waitMs });
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    const MAX_RETRIES = 2;
    let delay = 3_000;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Re-check the circuit on each retry — a prior attempt may have just tripped it.
      if (this._isCircuitOpen()) {
        const remainingSec = Math.ceil((this._circuitUntil - Date.now()) / 1000);
        logger.warn('sendMessage aborted mid-retry by circuit breaker', { attempt, remainingSec });
        throw new Error(`circuit breaker open during retry, ${remainingSec}s remaining`);
      }

      const res = await this.request<{ ret?: number; errmsg?: string }>('ilink/bot/sendmessage', req);
      if (res.ret === -2) {
        // Distinguish stale-session (ret:-2 + errmsg "unknown error") from a real rate-limit.
        // Hermes WeChat adapter established this pattern: the stale-session case behaves
        // like errcode:-14 and is fixed by re-login, not by retry.
        const errmsg = (res.errmsg ?? '').toLowerCase();
        if (errmsg === 'unknown error') {
          logger.warn('sendMessage stale session detected (ret:-2 + unknown error)', { userId });
          if (userId) {
            this.nextSendTime.set(userId, Date.now() + WeChatApi.STALE_SESSION_PAUSE_MS);
          }
          throw new Error('stale session — user must send a message to refresh context_token');
        }

        // Real rate-limit: trip the circuit breaker so subsequent sends fail fast.
        this._tripCircuit();
        if (userId) {
          this.nextSendTime.set(userId, Date.now() + WeChatApi.RATE_LIMIT_COOLDOWN_MS);
        }
        if (attempt === MAX_RETRIES) {
          logger.warn('sendMessage rate-limited after max retries', { attempts: MAX_RETRIES });
          throw new Error(`sendMessage rate-limited after ${MAX_RETRIES} retries`);
        }
        logger.warn('sendMessage rate-limited (ret:-2), retrying', { attempt, delayMs: delay });
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 15_000);
        continue;
      }
      return;
    }
  }

  // ── Circuit breaker helpers ────────────────────────────────────────────

  /** True while the breaker is open (sends should fail fast). */
  private _isCircuitOpen(): boolean {
    if (this._circuitUntil === 0) return false;
    if (Date.now() >= this._circuitUntil) {
      this._circuitUntil = 0;
      this._rateLimitEvents.length = 0;
      return false;
    }
    return true;
  }

  /** Record a rate-limit event and open the breaker if threshold is met. */
  private _tripCircuit(): void {
    const now = Date.now();
    const windowStart = now - WeChatApi.CIRCUIT_WINDOW_MS;
    while (this._rateLimitEvents.length > 0 && this._rateLimitEvents[0] < windowStart) {
      this._rateLimitEvents.shift();
    }
    this._rateLimitEvents.push(now);
    if (this._rateLimitEvents.length >= WeChatApi.CIRCUIT_THRESHOLD) {
      const openUntil = Math.max(this._circuitUntil, now + WeChatApi.CIRCUIT_OPEN_MS);
      if (openUntil > this._circuitUntil) {
        logger.warn('Circuit breaker tripped', {
          events: this._rateLimitEvents.length,
          openMs: WeChatApi.CIRCUIT_OPEN_MS,
        });
      }
      this._circuitUntil = openUntil;
    }
  }

  /** Fetch bot config (includes typing_ticket). */
  async getConfig(ilinkUserId: string, contextToken?: string): Promise<GetConfigResp> {
    return this.request<GetConfigResp>(
      'ilink/bot/getconfig',
      { ilink_user_id: ilinkUserId, context_token: contextToken },
      10_000,
    );
  }

  /** Send a typing indicator to a user. */
  async sendTyping(req: SendTypingReq): Promise<void> {
    await this.request('ilink/bot/sendtyping', req, 10_000);
  }

  /** Get a presigned upload URL for media files. */
  async getUploadUrl(req: import('./types.js').GetUploadUrlReq): Promise<GetUploadUrlResp> {
    return this.request<GetUploadUrlResp>('ilink/bot/getuploadurl', req);
  }
}
