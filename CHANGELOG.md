# Changelog

## [0.1.0] - 2026-08-18

### Added

- DSH 微信桥接插件首个可运行版本。
- 微信扫码绑定、文字/图片/语音转文字/文件收发。
- DSH Host 插件：内部 HTTP+SSE API、守护进程管理、模型工具。
- Web 管理面板（`conversation.view` 槽位）。
- 流式回复批量发送、超时安抚、消息队列、斜杠命令。
- DSH 会话 ID 持久化映射，跨 DSH Host 重启尝试 `resume`。

### Fixed

- 修复 `conversation.view` 管理面板空白：将非 React 的 `{ render() }` 注册改为真正的 React 组件。
