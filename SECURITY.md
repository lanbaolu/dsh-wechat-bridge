# 安全策略 / Security Policy

## 报告漏洞 / Reporting a Vulnerability

请**不要**在公开 Issue 中提交安全漏洞或敏感信息。

- 优先使用 GitHub 的 **Private vulnerability reporting**（仓库公开后可用）。
- 如果没有开启，可创建 Issue 时选择 `security` 标签，并仅提供脱敏信息；或直接联系维护者（见仓库主页）。

## 安全注意事项

- 本插件会保存微信账号凭证到本机数据目录（默认 `~/.dsh/wechat-bridge/accounts/`），文件权限为 `0600`。
- 日志中的 token / secret / password 会尽量脱敏，但请勿把原始日志直接贴到 Issue。
- 内部 HTTP API 只监听 `127.0.0.1`，并使用随机 token 鉴权；请勿修改为公网监听。

## 不在范围内的内容

- 个人微信账号封禁风险：本项目仅用于个人学习与自动化，使用者需自行承担微信协议使用风险。
