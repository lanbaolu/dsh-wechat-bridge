# @lanbaolu/dsh-wechat-bridge

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)
![CI](https://github.com/lanbaolu/dsh-wechat-bridge/actions/workflows/ci.yml/badge.svg)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

基于 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) 开发的 **DeepSeek Harness (DSH) 微信桥接插件**。

> ⚠️ 免责声明：本项目仅用于个人学习与自动化。使用非官方微信协议存在账号风险，请自行评估并承担后果。

**三端通用**：Windows / macOS / Linux 均使用纯 Node.js 进程管理，不依赖 launchd / systemd / Windows Service；同时提供 DSH 模型工具（CLI/Headless 可用）和 Web 管理面板（Web/桌面可用）。

## 功能

- 微信扫码绑定个人微信后，在微信里直接与 **DSH 本机 Agent** 对话。
- 复用 wechat-claude-code 的 iLink Bot 微信协议层：文字、图片、语音转文字、文件收发。
- 守护进程由 DSH 插件管理：启动 / 停止 / 重启 / 状态 / 日志，全部走模型工具或 Web 面板。
- 每个微信账号对应一个 DSH 会话，DSH Host 重启后会自动 `resume` 原持久化会话，对话上下文不断档；`/clear`、`/new`、`/stop`、`/cwd`、`/model`、`/prompt` 等斜杠命令可用。
- 流式回复：DSH Agent 的 `assistant/chunk` 通过本地 SSE 推送到微信（批量发送，不刷屏）。
- 超时安抚：DSH 超过 5 分钟无输出时自动发一条“还在处理”的消息。
- 主动通知：agent 可通过 `wechat_notify` 工具在任务完成 / 失败 / 需要确认时主动推送微信，内置节流（每小时 ≤6 条、每日 ≤50 条，超限排队延迟发送），规避个人号风控。
- **微信内审批**：agent 请求权限时推送审批消息到微信，回复 `/yes` 批准、`/no` 拒绝；超时自动拒绝（fail-closed），仅绑定账号本人可裁决，不影响桌面 GUI 会话。
- 防卡死：微信会话自动注入通道约束提示词，禁用浏览器端交互式选项工具（手机看不到会永久阻塞），改用纯文本编号选项。
- 文件双向：微信发图片/文件给 DSH；DSH 回复中提到的本地文件会自动推回微信。
- 消息队列：处理中收到的普通消息会排队，等当前任务结束后继续处理（多用户下按用户独立排队，A 的长任务不阻塞 B）。
- **多用户支持**：信任集 + per-user 会话。可让多个微信用户与同一 bot 对话，每人独立会话/上下文/队列/审批归属，互不可见；信任集可控、可吊销（详见下方「安全模型」）。

### 媒体能力矩阵（2026-08-21 代码核实 + 真机抽验；2026-08-29 视频收发补齐）

| 方向 | 文本 | 图片 | 语音 | 文件 | 视频 |
|---|---|---|---|---|---|
| 微信 → DSH | ✅ | ✅ CDN 下载+解密落盘 | ✅ iLink 端转写为文本 | ✅ 下载落盘交 agent | ✅ CDN 下载落盘交 agent（存 .mp4） |
| DSH → 微信 | ✅ 攒批聚合发送 | ✅ 按扩展名路由直发 | — | ✅ 回复提及自动推送 | ✅ 按扩展名路由直发（mp4/mov/webm/mkv/avi） |

> 语音出站（DSH → 微信）仍未支持：协议无公开实现参考，需真机实测后补齐。视频收发为 2026-08-29 按 iLink/ClawBot 协议源码补齐，**真机收发待抽验**（详见「验证状态」）。

方向对照与后续可行性方案见 [`docs/feasibility-plan.md`](docs/feasibility-plan.md)。

## 架构

```
微信 App ←→ iLink Bot API ←→ bridge daemon (Node.js)
                                  │  HTTP + SSE (127.0.0.1, token 鉴权)
                                  ▼
                          DSH Host Plugin
                                  │  ctx.agents.create/resume + followup
                                  ▼
                          DSH Agent (本机 LLM + 工具)
```

- `src/bridge/`：从 wechat-claude-code 移植的微信协议层 + 适配 DSH 的守护进程。
- `src/index.ts`：DSH Host 插件，负责内部 API、Agent 生命周期、守护进程管理和模型工具。
- `src/client/index.ts`：Web 管理面板（`settings.section` 槽位）。

## 安装

### 方式一：npm 一键安装（推荐）

```bash
npm install @lanbaolu/dsh-wechat-bridge
dsh plugin --profile web add @lanbaolu/dsh-wechat-bridge
dsh web
```

### 方式二：本地路径安装（开发/个人使用）

在 DSH profile 中安装本地包：

```bash
git clone https://github.com/lanbaolu/dsh-wechat-bridge.git
dsh plugin --profile web add /path/to/dsh-wechat-bridge
dsh web
```

或者使用超级注入器（开发模式）：

```bash
dev_inject_plugin /path/to/dsh-wechat-bridge
```

### 方式三：从源码运行

```bash
npm install
npm run build        # host → lib/
npm run build:client # client → lib/client.js
npm run typecheck
```

> 注意：`build:client` 使用 `tsdown`，需要 Node.js 22.18+ 或 24.11+（CI 使用 22/24 验证）。运行时要求仍为 Node 18+。

## 使用

### 1. 扫码绑定

推荐在 DSH Web 设置页的「📱 微信桥接」面板中完成：

1. 打开 **Settings / 设置** → **📱 微信桥接**。
2. 填写 DSH 工作目录。
3. 点击 **扫码绑定**，用微信扫描页面上的二维码。
4. 绑定成功后直接点击 **启动**。

也可以在 DSH 所在机器终端执行：

```bash
node lib/bridge/main.js setup
```

按提示用微信扫码，完成后选择 DSH 工作目录。

### 2. 启动桥接

在 DSH 对话中让模型执行：

- `wechat_bridge_start`
- `wechat_bridge_status`
- `wechat_bridge_logs`
- `wechat_bridge_stop`

或者在 Web 设置页（`settings.section` 槽位）点击“启动 / 停止 / 重启”。

### 3. 微信端命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/clear` | 清除当前 DSH 会话 |
| `/new` | 开启全新会话（等价 `/clear`） |
| `/stop` | 停止当前任务并清空排队消息 |
| `/status` | 查看会话状态 |
| `/cwd [路径]` | 查看 / 切换工作目录 |
| `/model [名称]` | 查看 / 切换模型 |
| `/prompt [内容]` | 查看 / 设置系统提示词 |
| `/history [数量]` | 查看最近对话 |
| `/send <路径>` | 发送本地文件到微信 |
| `/trust <userId> [备注]` | 添加信任用户（manual 模式；仅 owner） |
| `/distrust <userId>` | 吊销信任用户（仅 owner） |
| `/trustlist` | 查看信任集（仅 owner） |
| `/trustmode [模式]` | 查看/切换信任模式（owner-only / bootstrap / manual） |

## 超时安抚配置

DSH 长时间没有产出消息时，桥接会主动发一条"还在处理"的安抚消息（默认 5 分钟静默后、每 5 分钟一条，避免用户以为卡死）。嫌频繁或想自定义，可在 Web 面板「⏳ 超时安抚」区块调整，或直接编辑 `config.json` 的 `calm` 节：

```jsonc
{
  "calm": {
    "enabled": true,        // 是否启用安抚，默认 true
    "silenceMs": 600000,    // 首次静默多久后安抚（毫秒），默认 300000（5 分钟）
    "intervalMs": 900000,   // 两次安抚最小间隔（毫秒），默认同 silenceMs
    "maxCount": 3,          // 每轮任务最多安抚次数，0/省略 = 不限制
    "messages": [           // 自定义文案（随机取一条），留空用内置默认
      "还在处理中，这个问题有点复杂，请再稍等一下",
      "马上就好，正在收尾"
    ]
  }
}
```

保存后即时生效（最长延迟数秒），无需重启守护进程。改动只在守护进程运行时展示于面板；若面板无「超时安抚」区块，请更新插件后重启 DSH。

## 防休眠（preventSleep）

默认关闭。开启后，守护进程运行期间会抑制系统休眠——锁屏/合盖不挂起，微信消息持续响应（适合挂机跑长任务）。

- 面板「💤 防休眠」开关，或直接编辑 `config.json`：

```jsonc
{
  "preventSleep": true
}
```

- 平台实现：macOS `caffeinate` / Linux `systemd-inhibit` / Windows `SetThreadExecutionState`（尽力而为）。
- 切换后需重启守护进程生效（面板「重启」按钮即可）。

## 安全模型（多用户信任集）

> iLink 微信协议的扫码绑定是 **bot 自身** 登录（不是用户配对）。因此"多用户"的边界在协议层之上划定：把可信微信用户的 `from_user_id` 加进**信任集**，放行/拒绝入站。

### 信任模式（fail-closed 默认）

| 模式 | 行为 | 适用 |
|---|---|---|
| `owner-only`（默认） | 只认绑定账号 owner 本人，陌生人一律拒绝 | 单用户，行为与旧版完全一致 |
| `bootstrap` | 首个联系的陌生人自动入信任集（一次性），之后不再自动 | 快速开号试用 |
| `manual` | 仅 owner 用 `/trust` 或 Web 面板显式添加的人可对话 | 正式多人使用 |

- 信任集持久化在 `trust.json`（0600），`mode` 是唯一真相源；`config.json` 只存 `notifyRejected`。
- **拒绝原则**：陌生人消息只记日志、不回复（不泄露任何内部信息）；可选 `notifyRejected: true` 让 owner 收到「陌生人尝试联系」提醒（Web 面板或 `/trustmode` 后由面板开关）。
- **吊销即失效**：`/distrust` 或面板「吊销」后，该用户新消息立刻被拒绝；其历史会话文件保留只读（不丢历史）。

### per-user 隔离

- 每个受信用户（含 owner）一套独立：DSH 会话（`${botAccountId}::${userId}` 为 key）、会话文件、消息队列、上下文 token、`/history` `/status` `/cwd` `/model`。
- A 的任务进行中，B 发消息不会被阻塞（独立队列）；A 的 `/yes` `/no` 只裁决 A 自己 agent 的待审批（审批 key 归属 session key），B 无权替 A 裁决。
- 项目绑定两级粒度：Web 面板选择项目会话 → 对该 bot 下**所有**用户生效；微信内 `/session` 绑定 → 仅对当前用户生效。

### 升级迁移

- 旧单用户数据自动迁移：`sessions/<accountId>.json` → `sessions/<accountId>__<ownerUserId>.json`，`session-ids.json` 旧 key → `${accountId}::${ownerUserId}`，迁移留痕日志，绝不丢历史；无法确定 owner 的旧数据保留原样只读。

> ⚠️ **验证状态（如实标注）**：信任集判定与迁移逻辑有纯函数单测覆盖（39 项）；
> owner-only 模式已真机回归（行为与旧版一致）。**多用户路径（bootstrap 入集、双用户隔离并发）
> 真机验证待补**——需要第二个微信账号走查，在此之前请仅在受控环境开启 `bootstrap`/`manual` 模式。

## 数据目录

默认 `~/.dsh/wechat-bridge/`（可用 `DSH_HOME` 调整）：

```
~/.dsh/wechat-bridge/
├── accounts/       # 微信账号凭证（0600）
├── sessions/       # 每个微信账号的本地会话状态
├── session-ids.json # 微信账号 → DSH 持久化会话 ID 映射（用于重启后 resume）
├── trust.json       # 多用户信任集（模式 + 信任用户，0600）
├── context-tokens.json # per-user context_token（主动推送/审批通行证）
├── pending-queue/  # 发送失败暂存队列
├── daemon-port.json # 守护进程 notify 端点端口（token 鉴权）
├── notify-stats.json # 主动通知每日配额计数
├── config.json     # 工作目录 / 模型 / 系统提示词
└── logs/           # 运行日志
```

## 安全说明

- 守护进程与 DSH 插件之间的内部 API 只监听 `127.0.0.1`，并使用随机 token 鉴权。
- 微信账号凭证仅保存在本机 `~/.dsh/wechat-bridge/accounts/`，权限为 0600。
- 日志中的 token / secret / password 会自动脱敏。
- 请勿把真实账号凭证、token 或日志提交到 Issue / PR。

## 贡献

欢迎提交 Issue 和 PR。请先阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)，并查看 [`SECURITY.md`](SECURITY.md) 了解安全报告方式。

## License

[MIT](LICENSE)
