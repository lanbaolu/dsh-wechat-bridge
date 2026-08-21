import { readFileSync, writeFileSync, chmodSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger.js";

export function validateAccountId(accountId: string): void {
  if (!/^[a-zA-Z0-9_.@=-]+$/.test(accountId)) {
    throw new Error(`Invalid accountId: "${accountId}"`);
  }
}

/**
 * Load a JSON file, returning a typed object or the fallback if the file
 * does not exist or cannot be parsed.
 */
export function loadJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // 崩溃安全：损坏文件改名隔离留证再回退默认值，绝不静默吞掉状态，
      // 也绝不让一个坏文件反复阻塞后续加载。
      try {
        renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
        logger.warn('loadJson quarantined corrupt file, using fallback', { filePath, error: err instanceof Error ? err.message : String(err) });
      } catch {
        logger.warn('loadJson failed (quarantine rename failed), using fallback', { filePath, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return fallback;
  }
}

/**
 * Persist an object as pretty-printed JSON.
 * File is written with mode 0o600 (owner read/write only).
 */
export function saveJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const raw = JSON.stringify(data, null, 2) + "\n";
  writeFileSync(filePath, raw, "utf-8");
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o600);
  }
}
