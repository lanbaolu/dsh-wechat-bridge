# Changelog

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
