# AGENTS.md

面向在本仓库中工作的 AI 编码智能体 / 开发者的项目约定。

## 项目简介

DSH（DeepSeek Harness）微信桥接插件。通过 iLink Bot 微信协议层把个人微信消息转发给本机 DSH Agent，并把 DSH 回复批量推回微信。三端通用（Windows / macOS / Linux）。

## 目录结构

- `src/index.ts`：DSH Host 插件，内部 HTTP+SSE API、Agent 生命周期、守护进程管理、模型工具。
- `src/bridge/`：微信协议层 + 独立守护进程（daemon）。
- `src/bridge/wechat/`：iLink Bot 协议、登录、媒体收发、监控、发送。
- `src/client/`：Web 管理面板（`conversation.view` 槽位）。
- `scripts/build.sh`：构建 host 到 `lib/`。
- `docs/`：方向对照与可行性方案。

## 常用命令

```bash
npm install
npm run typecheck
npm run build
npm run build:client
```

## 约定

- 使用 TypeScript 严格模式；源码在 `src/`，构建产物 `lib/` 不入库。
- 微信消息推送必须批量发送（阈值 + 定时器），不能每个 chunk 都发一条微信消息。
- 程序化创建 DSH Agent 时必须显式传入 provider/model（读取 `ctx.agentDefaultModel.currentSelection()`）。
- 不要提交本地账号、token、密钥、日志或真实聊天记录。
