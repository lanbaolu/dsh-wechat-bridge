# 贡献指南 / Contributing Guide

欢迎贡献！在提交 PR 前请阅读以下约定。

## 开发环境

- Node.js >= 18
- npm
- 可选：本地 DSH 环境（用于真机联调）

```bash
npm install
npm run typecheck
npm run build
npm run build:client
```

## 提交 PR

1. Fork 本仓库并创建功能分支（`feat/xxx`、`fix/xxx`）。
2. 修改代码，保持 TypeScript 严格模式通过。
3. 本地跑通 `typecheck` 与 `build`。
4. 提交信息使用简洁的祈使句，例如 `fix: batch WeChat streaming replies`。
5. 创建 PR 时填写模板，说明改动和测试方式。

## 代码约定

- 源码在 `src/`，输出到 `lib/`（不提交 `lib/`）。
- 微信协议层在 `src/bridge/wechat/`，DSH Host 插件在 `src/index.ts`。
- 新增对外能力时同步更新 `README.md` 和 `docs/`。
- 不得提交任何账号、token、密钥、日志或真实聊天记录。
