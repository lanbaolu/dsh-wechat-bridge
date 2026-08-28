import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, DEFAULT_WORKING_DIR } from "./constants.js";

export interface Config {
  workingDirectory: string;
  model?: string;
  systemPrompt?: string;
  /** 每轮回复末尾附加上下文用量尾注（🧮），默认开启。 */
  usageFooter?: boolean;
  /**
   * 陌生人尝试联系时是否向 owner 推送一条提示（用于察觉账号被盯上）。
   * 默认 false，bootstrap/manual 模式下建议开启。
   * 信任模式本身存放在 trust.json（唯一真相源），不在这里重复。
   */
  notifyRejected?: boolean;
  /** 超时安抚消息配置（见 CalmConfig）。缺省时保持内置行为：5 分钟静默后每 5 分钟安抚一次。 */
  calm?: CalmConfig;
}

/**
 * 超时安抚：DSH 长时间没有产出消息时，主动发一条"还在处理"的安抚消息。
 * 所有字段均可省略，省略即用内置默认值。
 */
export interface CalmConfig {
  /** 是否启用安抚消息，默认 true。 */
  enabled?: boolean;
  /** 首次静默多久后开始安抚（毫秒），默认 5 分钟。 */
  silenceMs?: number;
  /** 两次安抚之间的最小间隔（毫秒），默认同 silenceMs。 */
  intervalMs?: number;
  /** 每轮任务最多安抚次数，0 或省略 = 不限制。 */
  maxCount?: number;
  /** 自定义安抚文案列表（每次随机取一条），留空用内置默认文案。 */
  messages?: string[];
}

const CONFIG_PATH = join(DATA_DIR, "config.json");

const DEFAULT_CONFIG: Config = {
  workingDirectory: DEFAULT_WORKING_DIR,
};

export function loadConfig(): Config {
  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(content);
    const config: Config = {
      workingDirectory: parsed.workingDirectory || DEFAULT_CONFIG.workingDirectory,
      model: parsed.model,
      systemPrompt: parsed.systemPrompt,
      usageFooter: parsed.usageFooter === undefined ? undefined : (parsed.usageFooter === true || parsed.usageFooter === 'true'),
      notifyRejected: parsed.notifyRejected === undefined ? undefined : (parsed.notifyRejected === true || parsed.notifyRejected === 'true'),
      calm: parseCalmConfig(parsed.calm),
    };
    mkdirSync(config.workingDirectory, { recursive: true });
    return config;
  } catch {
    const config = { ...DEFAULT_CONFIG };
    mkdirSync(config.workingDirectory, { recursive: true });
    return config;
  }
}

export function parseCalmConfig(raw: unknown): CalmConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const calm: CalmConfig = {};
  if (typeof r.enabled === 'boolean' || r.enabled === 'true' || r.enabled === 'false') {
    calm.enabled = r.enabled === true || r.enabled === 'true';
  }
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
  };
  calm.silenceMs = num(r.silenceMs);
  calm.intervalMs = num(r.intervalMs);
  const maxCount = typeof r.maxCount === 'string' ? Number(r.maxCount) : r.maxCount;
  if (typeof maxCount === 'number' && Number.isFinite(maxCount) && maxCount >= 0) calm.maxCount = maxCount;
  if (Array.isArray(r.messages)) {
    const msgs = r.messages.filter((m): m is string => typeof m === 'string' && m.trim().length > 0);
    if (msgs.length > 0) calm.messages = msgs;
  }
  return calm;
}

export function saveConfig(config: Config): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const data: Record<string, unknown> = {
    workingDirectory: config.workingDirectory,
  };
  if (config.model) data.model = config.model;
  if (config.systemPrompt) data.systemPrompt = config.systemPrompt;
  if (config.usageFooter !== undefined) data.usageFooter = config.usageFooter;
  if (config.notifyRejected !== undefined) data.notifyRejected = config.notifyRejected;
  if (config.calm !== undefined) data.calm = config.calm;
  writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
  if (process.platform !== "win32") {
    chmodSync(CONFIG_PATH, 0o600);
  }
}
