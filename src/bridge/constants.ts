import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Bridge data directory.
 *
 * Default: $DSH_HOME/wechat-bridge (or ~/.dsh/wechat-bridge when DSH_HOME is
 * unset). The host plugin sets DSH_BRIDGE_DATA_DIR explicitly when spawning
 * the daemon, so both the plugin and the standalone daemon always agree.
 */
export const DATA_DIR = process.env.DSH_BRIDGE_DATA_DIR
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'wechat-bridge');

export const DEFAULT_WORKING_DIR = join(homedir(), 'Documents', 'DSH');

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
