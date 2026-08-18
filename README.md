# @dsh-external/dsh-wechat-bridge

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
- 文件双向：微信发图片/文件给 DSH；DSH 回复中提到的本地文件会自动推回微信。
- 消息队列：处理中收到的普通消息会排队，等当前任务结束后继续处理。

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
- `src/client/index.ts`：Web 管理面板（`conversation.view` 槽位）。

## 安装

### 方式一：本地路径安装（推荐开发/个人使用）

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

### 方式二：从源码运行

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

## 数据目录

默认 `~/.dsh/wechat-bridge/`（可用 `DSH_HOME` 调整）：

```
~/.dsh/wechat-bridge/
├── accounts/       # 微信账号凭证（0600）
├── sessions/       # 每个微信账号的本地会话状态
├── session-ids.json # 微信账号 → DSH 持久化会话 ID 映射（用于重启后 resume）
├── pending-queue/  # 发送失败暂存队列
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
