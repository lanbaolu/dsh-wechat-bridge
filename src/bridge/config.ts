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
    };
    mkdirSync(config.workingDirectory, { recursive: true });
    return config;
  } catch {
    const config = { ...DEFAULT_CONFIG };
    mkdirSync(config.workingDirectory, { recursive: true });
    return config;
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const data: Record<string, string | boolean> = {
    workingDirectory: config.workingDirectory,
  };
  if (config.model) data.model = config.model;
  if (config.systemPrompt) data.systemPrompt = config.systemPrompt;
  if (config.usageFooter !== undefined) data.usageFooter = config.usageFooter;
  if (config.notifyRejected !== undefined) data.notifyRejected = config.notifyRejected;
  writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
  if (process.platform !== "win32") {
    chmodSync(CONFIG_PATH, 0o600);
  }
}
