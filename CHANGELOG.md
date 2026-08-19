# Changelog

## [0.3.0] - 2026-08-18

### Added

- 新增模型工具 `wechat_notify`：agent 可在任务完成 / 失败 / 需要用户确认或决策等场景主动向绑定微信推送通知。
- 守护进程新增内部 `POST /notify` 端点（127.0.0.1 + token 鉴权，端口写入 `daemon-port.json`）。
- 新增主动通知节流队列（`src/bridge/notify.ts`）：每小时 ≤6 条、每日 ≤50 条、相邻最小间隔 1 分钟、发送前随机抖动打散固定节奏、队列满丢最旧。规避微信个人号协议对主动高频推送的风控敏感。
- 每日通知配额持久化（`notify-stats.json`），守护进程重启后不丢失。
- 新增 `GET /notify/status` 端点与 Web 面板「主动通知节流」展示区：今日已发 N/50、近一小时 n/6、排队 m 条。

## [0.2.0] - 2026-08-18

### Added

- 支持将微信桥接绑定到 DSH 项目会话，微信消息直接复用所选项目会话，实现跨会话记忆 / 接着电脑端会话聊。
- Web 管理面板新增「项目对话绑定」区域，可列出项目会话并绑定/解绑。
- 微信端新增 `/sessionlist`、`/session <序号或ID>`、`/session off` 命令。
- 新增模型工具 `wechat_bridge_list_projects` / `wechat_bridge_select_project`，可在微信里通过自然语言查看并进入项目。
- 新增内部 API：`/api/projects`、`/api/projects/select`、`/api/projects/detach`。
- 新增 `selected-sessions.json` 持久化项目绑定关系。

### Fixed

- 确认并记录 Web 管理面板标签点击无反应问题已修复（React 组件两参注册）。

## [0.1.1] - 2026-08-18

### Fixed

- 重新扫码绑定后，守护进程会自动重启/启动并加载新账号，不再继续使用旧会话。
- `autoStart` 默认改为 `true`，DSH 重启后桥接自动启动。
- 增加守护进程看门狗：电脑休眠唤醒或守护进程异常退出后，自动重新拉起。

## [0.1.0] - 2026-08-18

### Added

- DSH 微信桥接插件首个可运行版本。
- 微信扫码绑定、文字/图片/语音转文字/文件收发。
- DSH Host 插件：内部 HTTP+SSE API、守护进程管理、模型工具。
- Web 管理面板（`settings.section` 槽位，设置页全局入口）。
- 设置页内首次扫码绑定：显示二维码、自动轮询扫码状态、绑定后写入工作目录配置。
- 流式回复批量发送、超时安抚、消息队列、斜杠命令。
- DSH 会话 ID 持久化映射，跨 DSH Host 重启尝试 `resume`。

### Changed

- 微信桥接管理面板从 `conversation.view` 会话标签移到 `settings.section` 设置页，不再依赖打开某个会话。

### Fixed

- 修复 `conversation.view` 管理面板空白：将非 React 的 `{ render() }` 注册改为真正的 React 组件。
