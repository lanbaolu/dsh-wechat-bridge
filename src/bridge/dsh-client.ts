import { logger } from './logger.js';

/**
 * Minimal HTTP+SSE client used by the bridge daemon to talk to the DSH host
 * plugin. The host owns the real DSH agent; the daemon only forwards WeChat
 * messages and pushes assistant events back.
 */

export interface DshPromptInput {
  text: string;
  sessionId: string;
  cwd?: string;
  model?: string;
  systemPrompt?: string;
  /** Local file paths already downloaded by the daemon (absolute paths). */
  files?: string[];
}

export interface DshStreamEvent {
  type: 'chunk' | 'done' | 'error' | 'status';
  text?: string;
  sessionId?: string;
  message?: string;
  turn?: number;
}

export class DshClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    };
  }

  async status(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/api/status`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`status HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  async prompt(input: DshPromptInput): Promise<{ accepted: boolean; messageId?: string }> {
    const res = await fetch(`${this.baseUrl}/api/prompt`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`prompt HTTP ${res.status}: ${text}`);
    }
    return res.json() as Promise<{ accepted: boolean; messageId?: string }>;
  }

  async stop(sessionId: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/stop`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  async clear(sessionId: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/clear`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  /**
   * Open an SSE stream for one session. The connection stays open across
   * multiple turns; the host sends `chunk`, `status`, and `done` events.
   */
  async stream(
    sessionId: string,
    onEvent: (event: DshStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = new URL(`${this.baseUrl}/api/stream`);
    url.searchParams.set('sessionId', sessionId);

    const res = await fetch(url, {
      headers: this.headers(),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`stream HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of rawEvent.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            onEvent(JSON.parse(payload) as DshStreamEvent);
          } catch (err) {
            logger.warn('Failed to parse SSE event', {
              payload,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }
  }
}
