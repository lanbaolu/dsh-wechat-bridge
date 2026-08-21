# Changelog

## [0.4.1] - 2026-08-21

### Fixed

- **微信 agent 挂载部署 preset**：程序化创建的 agent 不挂 preset 时工具/技能/提示词全部退化到空全局层（实测微信 agent 拿不到 shell）。现于 setup 钩子中 `AgentPresets.mount()` 挂部署默认 preset（router-standard），shell/技能恢复可用，inject 声明补 `agentPresets`。
- **Web 面板路由注册**：webServer fiber 晚于插件装配时 `ctx.get('webServer')` 静默拿到 undefined，11 条面板路由全部丢失、面板退化为 SPA 空壳（Safari 报 "The string did not match the expected pattern."）。改用 `ctx.inject(['webServer'])` 在服务激活后注册，headless 环境不受影响。

## [0.4.0] - 2026-08-21

### Added

- **微信内审批**：agent 请求权限时自动推送审批消息到绑定微信，回复 `/yes` 批准、`/no` 拒绝；默认 5 分钟超时自动拒绝（fail-closed，可用 `approvalTimeoutSec` 调整；`approvalViaWechat=false` 可完全交回桌面 GUI）。基于 DSH 内核 `approval/request` 瀑布事件的 scoped 应答器实现，只作用于微信桥自己的 agent，不影响桌面会话。
- 守护进程新增内部 `POST /approval` 端点（127.0.0.1 + token 鉴权）：审批消息绕过节流直发（阻塞交互不能等通知队列的 60s 最小间隔）。
- `/yes` `/no` 与 `/stop` 同级：抢在消息队列之前处理，避免任务挂起时审批回复被排队到死锁；发送者校验 fail-closed，仅绑定账号本人可裁决。
- **防卡死**：微信桥 agent 创建/恢复时通过 `setup` 钩子注入 scoped 提示词段落，明确禁止模型使用 `ask_user_question` 等交互式选项工具（选项只弹在电脑浏览器，微信用户看不到会永久阻塞），引导模型改用纯文本编号选项。

### Fixed

- 修复主动推送通道：iLink 主动发消息（bot → 用户）必须回传最近一次入站消息的 `context_token`，空 token 被服务端拒绝（`ret:-2 "prepare failed"`，实测）。现每条入站消息刷新并持久化 `context-token.json`（重启不丢），主动通知与审批推送共用。此缺陷同时影响 0.3.0 的 `wechat_notify`，一并修复。

### Security

- 审批裁决严格归属：`/yes` `/no` 只裁决本账号自己 agent 的 pending 请求；同一账号同时只允许一条待审批，并发新请求自动交回瀑布下游；请求被撤销（如 `/stop`）时立即收敛为 cancelled，迟到回复不再生效。

## [0.3.1] - 2026-08-20

### Fixed

- 修复安全缺陷：优先级斜杠命令（`/stop`、`/clear`、`/new`）此前未校验发送者，任何能向绑定微信发消息的联系人都可在对话进行中清空队列 / 中断进行中的对话 / 清空会话。现与普通消息一致，仅绑定账号本人可触发。
- 发送者守卫改为 fail-closed：账号记录缺少 `userId` 时拒绝一切发送者（不再因字段为空而放行所有人）。

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
