# Changelog

## [0.8.0] - 2026-08-29

### Added

- **发送失败补发闭环（pending-queue 接入）**：整轮流式发送结束仍未能发出的缓冲会落盘暂存（`pending-queue/<accountId>.json`，带 `userId` 区分多用户目标），daemon 启动即补发一次 + 每 5 分钟重试，发送成功才移除，失败保留下轮再试——发送失败不再因 daemon 退出而永久丢失。
- **防休眠（preventSleep）**：config.json 新增 `preventSleep`（默认关）。开启后 daemon 运行期间抑制系统休眠，锁屏/合盖不挂起、微信消息持续响应；macOS `caffeinate` / Linux `systemd-inhibit` / Windows `SetThreadExecutionState`（尽力而为）。面板新增「💤 防休眠」开关，重启 daemon 生效。

### Changed

- **单测纳入 CI**：`.github/workflows/ci.yml` build 后运行 `tests/session-key.test.cjs` + `tests/trust.test.cjs`（39 项断言），回归有保障。
- 发展方向方案存档 `docs/future-plan.md`（P0/P1/P2 分期）。

## [0.7.1] - 2026-08-29

### Fixed

- **扫码重绑后面板报「HTTP 400」**：扫码确认 → `restartDaemon` → `stopDaemon` kill 旧 daemon 后 `await 500ms` 期间，daemon 退出事件（`child.on('exit')`）把 `bridgeChild` 清成 `undefined`，随后访问 `bridgeChild.exitCode` 抛 TypeError，且 `setup/start`、`setup/status` 端点 handler 无 try/catch，异常冒泡到宿主 web server 变成裸 HTTP 400。修复：`stopDaemon` 改局部 `child` 引用（await 后仍可读 `exitCode`）；两个 setup 端点 handler 加 try/catch，内部错误返回结构化 JSON（面板显示具体原因而非状态码）。

## [0.7.0] - 2026-08-28

### Added

- **超时安抚配置化（issue #2）**：`config.json` 新增 `calm` 节——`enabled`（开关）/ `silenceMs`（首次静默，默认 5 分钟）/ `intervalMs`（重复间隔，默认同 silenceMs）/ `maxCount`（每轮上限，0 = 不限）/ `messages`（自定义文案，随机取一条）。Web 面板新增「⏳ 超时安抚」区块可视化配置（开关 + 分钟数 + 上限 + 文案编辑），并新增 `/config` 读写端点。保存后即时生效（最长延迟数秒），无需重启；全部缺省时行为与旧版完全一致。

### Fixed

- **面板深色主题文字不可读（PR #1）**：面板 CSS 变量映射到宿主真实 `--dsw-alias-*` 主题体系（保留 fallback 兼容非 DSH 宿主），深色主题下文字/按钮恢复可读，浅色主题无回归。
- **daemon 在 DSH Desktop（Electron 宿主）下无法启动**：`spawn` 注入 `ELECTRON_RUN_AS_NODE=1`，避免 watchdog 每次拉起都启动一个 Electron 实例（表现为不停开新窗口、daemon 秒退循环）。

## [0.6.0] - 2026-08-23

### Added

- **多用户支持（P1-2）**：信任集 + per-user 会话。对标 Kairos0922 的多用户能力，多个微信用户可与同一 bot 对话，每人独立会话/上下文/队列/审批归属，互不可见。
  - **信任集**（`trust.json`，0600）：三种模式——`owner-only`（默认，行为与旧版完全一致）/ `bootstrap`（首个联系的陌生人自动入集，一次性）/ `manual`（仅 `/trust` 或面板显式添加）。
  - 信任命令（仅 owner）：`/trust <userId> [备注]`、`/distrust <userId>`、`/trustlist`、`/trustmode [owner-only|bootstrap|manual]`。
  - **per-user 会话隔离**：session key 统一为 `${botAccountId}::${userId}`；每个用户独立会话文件、DSH agent、消息队列（A 的长任务不再阻塞 B）、上下文 token、`/history` `/status` `/cwd` `/model`。
  - **审批归属严格化**：`/yes` `/no` 只裁决自己 agent 的 pending（key = session key）；审批/主动通知推送按发起用户显式带 `userId`，推给本人而非固定 owner。
  - **信任门禁前置**：优先命令（`/stop` `/clear` `/new`）与审批回复也走信任门禁，owner-only 下仍仅 owner；多用户下受信用户可停自己的任务/清自己的会话。
  - **升级迁移（防丢数据）**：旧单用户 `sessions/<accountId>.json` → `sessions/<accountId>__<ownerUserId>.json`，`session-ids.json` 旧 key → `${accountId}::${ownerUserId}`；迁移只改名不重写，无法确定 owner 时保留原文件，全部留痕日志。
  - **Web 面板信任用户区**：模式切换、陌生人提醒开关、信任列表（userId/备注/最近活跃/来源）+ 添加 + 吊销；`/trust` 等 4 条新 Web 路由（11 → 15）。
  - `notifyRejected` 配置：陌生人尝试联系时向 owner 推提醒（默认关）。

### Changed

- 信任模式唯一真相源收口到 `trust.json`（不再与 config.json 双源漂移）。
- `readBridgeConfig`/`saveBridgeConfig` 改为合并写回，不再抹掉 daemon 写入的 `usageFooter` 等字段。
- 项目绑定两级粒度：面板选择 = 账号级（bot 下所有用户生效）；微信 `/session` = 用户级（仅本人）。
- DSH 会话 ID 生成对 session key 做字符清洗（`:` → `-`），避免 Windows 文件系统非法字符。

### Security

- 多用户下 `/stop` `/clear` `/new` `/yes` `/no` 从「仅 owner」放宽为「任意受信用户但只作用于自己的会话」，归属不越权。

### Fixed（发布前 code review）

- `/trustmode` 文案纠正：切换实际立即生效（原写"重启桥接后生效"误导）；router 注释同步修正（trustMode 写入 trust.json 而非 config.json）。
- **lastSeenAt 落盘**：`decideTrust` trusted 分支不再就地改 file，返回新对象；门禁对 lastSeenAt 刷新 60s 节流落盘——面板「最近活跃」与 `/trustlist` 重启后不再丢。
- **notifyRejected 提醒走节流队列**：陌生人联系提醒经 notifyThrottle 发送（原来直接 sendText，多消息会撞 iLink 主动推送风控）。
- **bootstrap 自动入集加 userId 形态校验**：异常字符（含 `::`/空格）直接拒绝不自动入集，避免后续 session key 构造抛错吞消息。
- `context-tokens.json` / `context-token.json` 写入补 0600 权限（与 trust/config 对齐安全基线）。
- 移除死字段 `CommandResult.trustChanged`（main 未消费）。
- 单测隔离数据目录（设 `DSH_BRIDGE_DATA_DIR` 到临时目录），不再污染真实 `~/.dsh/wechat-bridge` 日志。

## [0.5.0] - 2026-08-21

### Added

- **上下文用量尾注**：每轮回复末尾附 `🧮 上下文约 N k tokens · 本轮输出 M`（inputTokens+cacheReadTokens ≈ 当前上下文大小），并入最后一段缓冲不额外产生消息；`config.json` 设 `usageFooter=false` 可关。
- **媒体能力矩阵**（README）：方向×类型实测表，如实标注未支持项（入站视频仅占位、出站视频未支持）。

### Security / Reliability（崩溃安全加固）

- **跨进程轮询锁**（`poll.lock`，pid 存活 + 90s 心跳，陈旧锁自动接管）：拒绝第二个活着的 daemon 同时轮询——游标双写会互相吞消息、双写会话日志。
- **入站去重**：按 message_id（缺省回退 seq）跳过重复投递，最近条目持久化 `dedup.json`（TTL 1h），崩溃重投/轮询重叠不再重复驱动 agent。
- **损坏文件隔离**：loadJson 解析失败时改名 `.corrupt-<ts>` 留证再回退默认值，不再静默吞掉状态，坏文件不会反复阻塞加载。

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
