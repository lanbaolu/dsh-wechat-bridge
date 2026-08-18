import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';

export interface PendingItem {
  text: string;
  role: 'interstitial' | 'final';
  queuedAt: number;
}

const QUEUE_DIR = join(DATA_DIR, 'pending-queue');

function queuePath(accountId: string): string {
  return join(QUEUE_DIR, `${accountId}.json`);
}

function ensureDir(): void {
  if (!existsSync(QUEUE_DIR)) {
    mkdirSync(QUEUE_DIR, { recursive: true });
  }
}

export function loadPendingQueue(accountId: string): PendingItem[] {
  try {
    const path = queuePath(accountId);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn('Failed to load pending queue', {
      accountId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export function savePendingQueue(accountId: string, items: PendingItem[]): void {
  try {
    ensureDir();
    writeFileSync(queuePath(accountId), JSON.stringify(items, null, 2), 'utf-8');
  } catch (err) {
    logger.warn('Failed to save pending queue', {
      accountId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function appendPending(accountId: string, item: PendingItem): PendingItem[] {
  const items = loadPendingQueue(accountId);
  items.push(item);
  savePendingQueue(accountId, items);
  return items;
}

export function clearPending(accountId: string): void {
  savePendingQueue(accountId, []);
}

export function hasPending(accountId: string): boolean {
  return loadPendingQueue(accountId).length > 0;
}
