# P1-2 多用户支持实施方案（信任集 + per-user 会话）

> 目标：对标 Kairos0922 的多用户能力——多个微信用户可与同一 bot 对话，
> 每人独立会话/上下文/偏好，互不可见；信任集可控、可吊销。
> 预估：2~2.5 天。状态：**未开工（已计划）**。

## 一、现状盘点（2026-08-21 代码核实）

单用户假设深入骨髓，改动的锚点全部列清：

| 位置 | 现状 | 多用户需要 |
|---|---|---|
| `main.ts` handleMessage | `msg.from_user_id !== account.userId` 直接丢弃 | 信任集判定 |
| session 存储 | `sessions/<botAccountId>.json` 单份 | 每用户一份 |
| host `sessionIds` Map | key = bot accountId | key = `botAccountId::userId` |
| host `ensureAgent` | 单 agent per bot account | per-user agent（已有 sessionId 参数，改动小） |
| `context-token.json` | 单 token | per-user Map |
| messageQueue | 全局单队列，一人长任务阻塞所有人 | per-user 队列 |
| approval manager | key = bot accountId（天然可扩展 per-user） | key 换成 session key |
| notify/审批推送 | `lastActiveUserId` 单目标 | 显式 userId |
| `/stop` `/clear` 等 | 仅 owner 本人 | 任何受信任用户，只作用于自己的会话 |
| 持久化 `session-ids.json` | 旧 key 格式 | 需要迁移逻辑 |

**协议限制说明**：iLink 的扫码是 bot 自身登录，不存在 Kairos0922 那种
"每个用户扫一次码配对"的通道。我们的"配对"= 把用户的 `from_user_id` 加入
信任集（owner 命令或面板操作），这是协议决定的，README 要写清楚。

## 二、里程碑拆分

### M1 信任集（0.5 天）
- `trust.json`：`{ mode, trusted: {userId: {addedAt, by}}, revoked: [...] }`，0600。
- daemon `config.json` 加 `trustMode`：
  - `'owner-only'`（**默认，与现状完全一致**，零行为变化）
  - `'bootstrap'`：首个联系的陌生人自动入信任集（一次性）
  - `'manual'`：仅 owner 显式添加
- owner 专属命令（发送者 fail-closed 校验，同 priority 命令）：
  `/trust <微信ID>`、`/distrust <微信ID>`、`/trustlist`
- handleMessage 门禁：`owner || trusted.has(userId)`，否则只记日志丢弃
  （可选 `notifyRejected` 配置：陌生人尝试联系时提醒 owner）。

### M2 per-user 会话（1 天）
- session key 统一为 `${botAccountId}::${userId}`（owner 也一样，走迁移）。
- daemon `sessions/<sanitized-key>.json` per-user；`sessionStore` API 已是
  per-accountId 参数化，改传 key 即可。
- host 侧 `ensureAgent(sessionKey)` / `disposeAgent(sessionKey)` /
  approval manager key / stream broadcast key 全部换成 session key——
  **这些 Map 本来就是 key 参数化的，是体力活不是设计活**。
- `/status` `/history` 等命令天然只看自己的（key 参数化后自动成立）。
- **迁移**：启动时若存在旧 key（bot accountId）的 session-ids.json 与
  sessions 文件，且能确定 owner userId → 一次性改名为新 key，日志留痕。
  不能确定则保留旧会话只读、新消息走新 key（绝不丢历史）。

### M3 per-user 运行时状态（0.5 天）
- `contextTokens: Map<userId, token>`（`context-tokens.json`），入站按
  from_user_id 刷新；主动推送/审批推送显式带 userId。
- messageQueue → `Map<userId, WeixinMessage[]>` + per-user drain
  （A 的长任务不再阻塞 B）。
- approval：pending key = session key；`/approval` 端点 body 加可选
  `userId`（缺省 lastActive 兼容）；`/yes` `/no` 仍只裁决本人 pending（已满足）。
- notify 节流保持全局（风控维度是账号级的，不随用户拆）。

### M4 面板 + 文档（0.5 天）
- 面板新增「信任用户」区：列表（userId / 加入时间 / 最近活跃）、吊销按钮、
  当前 trustMode 展示与切换。路由走现有 `/@lanbaolu/dsh-wechat-bridge/*`。
- README「安全模型」章节（对标 Kairos0922 的叙事）：
  信任集构成、fail-closed 原则、per-user 隔离、审批归属、吊销。
- `/help` 补 /trust 系列。

## 三、验证计划（吸取 0.4.0 教训：全闭环才发布）

1. **owner-only 回归**：默认模式行为与现在逐条一致（发消息/命令/审批/尾注）。
2. **bootstrap 模式**：owner 先触发 bootstrap 后，第二账号（找朋友微信或
   小号）发消息 → 自动入信任集并可对话，会话与 owner 隔离。
3. **manual 模式**：`/trust` 加人 → 可对话；`/distrust` → 立刻失效；
   陌生人消息只记日志。
4. **隔离性**：两用户并发发消息 → 各自队列、各自会话历史、`/history`
   互不可见；A 的审批 `/yes` 不能裁决 B 的 pending。
5. **迁移**：带旧单用户数据启动 → owner 历史会话无缝续上。
6. 自动化：trust 判定 + 迁移逻辑写纯函数单测（node 脚本，同审批测试模式）。

## 四、明确不做

- ❌ 群聊（腾讯未向 bot 开放群事件，全行业同款限制）。
- ❌ per-user 模型/工作区偏好切换命令（Kairos0922 有，我们二期再说；
  一期每人已有独立会话与 `/cwd` `/model`——命令是 per-session 的，
  实际上天然 per-user 生效）。

## 五、风险

- **真机双账号测试依赖第二微信账号**——没有就用小号；再不行 M1/M2 靠
  单测 + 日志走查，发布前标注"多用户路径真机验证待补"，**绝不静默发布**。
- 迁移逻辑是唯一可能丢数据的地方：只改名不重写内容，失败保留原文件。
