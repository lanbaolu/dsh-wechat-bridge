# 竞争差异化实施方案

> 背景：GitHub 上已有 19 个 dsh-wechat-bridge 同类仓库（2026-08 调研）。
> 领先者 gtaifu（8★，占住 npm 无作用域名）、Kairos0922（功能最全：审批/多用户/出站限流）、
> msg-hub（多渠道+主动推送）、NattoCB（崩溃安全叙事）。本文档是我们的反超方案。
>
> 定位一句话：**"唯一一个 agent 自己能管理的微信桥——面板、审批、防风控、崩不坏，装上就不用管。"**

## 一、已核实的技术底座（方案前提）

| 结论 | 出处 |
|---|---|
| `agents.create/resume` 支持 `setup?: AgentSetup` 钩子，回调接收 agent 作用域 `agentCtx`，其中注册的内容在 agent 公布前生效，scope 过滤只影响该 agent | `@deepseek-ai/dsh-agent` CreateAgentOptions/ResumeAgentOptions |
| 审批走 `ctx.on('approval/request', (req, next) => outcome)` 瀑布事件；outcome 词表 `'allowed-once'/'rejected'/'cancelled'/'unavailable'`；无应答器时 fail-closed | `@deepseek-ai/dsh-user-approval` |
| `ctx.userQuestions.registerProvider()` 全局仅一个活跃 provider，且校验"精确存活根 agent"——scoped provider 可行性待验证 | `@deepseek-ai/dsh-user-questions` |
| 系统提示词可按 scope 注入：`system-prompt/assemble` 瀑布（scope 过滤）或 `systemPrompt.section()` | `@deepseek-ai/dsh-system-prompt` |
| 我们当前代码无 `ask_user_question` 防护、无审批应答 | 本仓库 grep 确认 |

---

## 二、P0：补"一票否决"短板（目标 v0.4.0）

### P0-1 `ask_user_question` 防卡死（估 0.5 天）

**问题**：微信会话里 agent 调用交互式选项工具时，选项只弹在浏览器 GUI，手机端看不到，agent 永久阻塞。

**方案**（双保险）：

1. **提示词注入（主）**：在 `ensureAgent` 的 `agents.create`/`agents.resume` 调用中加 `setup` 钩子，通过 `agentCtx` 注册 scoped 提示词段落（order 取工具指导段 100–199）：

   ```
   你正在通过微信与用户对话。用户只能看到纯文本消息，无法看到也无法点击任何
   交互式选项界面。绝对不要使用 ask_user_question 等交互式选项工具——改用纯
   文本列出编号选项让用户回复数字；需要确认时直接以问句结尾等待回复。
   ```

2. **护栏（备）**：`setup` 里同步注册 `agentCtx.on('approval/request')` 之前，先验证能否在 scoped ctx 上 `userQuestions.registerProvider`；若可行，provider 直接把问题编号发微信、等下一条消息作答（这就从"防卡死"升级成"微信原生问答"，比 NattoCB 的纯回避更强）。若不可行（全局唯一 provider 冲突），仅保留提示词注入。

**改动文件**：`src/index.ts`（ensureAgent 的 create/resume 加 setup）、新增 `src/agent-setup.ts`。
**验证**：单测 mock agentCtx；真机用"帮我选 A 还是 B"类提示复现。

### P0-2 微信内审批 `/yes` `/no`（估 2 天）⭐ 核心卖点

**架构**：

```
agent 请求权限
  → ctx.approval 瀑布 'approval/request'（scope 过滤，只到我们的 agent）
  → 我们的应答器（setup 中经 agentCtx.on 注册）：
      1. 反查 agent → accountId（ensureAgent 建 agent→accountId 反向 Map）
      2. 经 daemon 推送微信：⚠️ 审批请求
         工具：bash   原因：需要删除临时目录
         命令：rm -rf /tmp/xxx
         回复 /yes 批准，/no 拒绝（5 分钟超时默认拒绝）
      3. 挂起 Promise，存 pendingApprovals: Map<accountId, {resolve, timer, req}>
      4. 微信回复到达 → commands/router 优先匹配 /yes|/no|1|2 → resolve
      5. 超时 → resolve('rejected') + 微信告知"已超时自动拒绝"
```

**安全约束**（沿用我们刚修的发送者校验教训，fail-closed）：
- 只应答**该 accountId 自己 agent** 的审批；`/yes` 只能由 pending 审批所属的微信号发出（router 里按 from_user_id 严格匹配）。
- 审批详情里的命令/路径原样展示（用户要看清再批），但 context_token 等凭证不落日志。
- 桥未连接/ daemon 离线时：监听者不注册或立即 `next()` 交回 GUI 应答器——**绝不阻塞也不吞审批**。
- 仅一条 pending 时允许回复 `1`/`2` 快捷应答（对齐 Kairos0922 体验）。

**配置项**（plugin config，面板可改）：
- `approvalTimeoutSec`（默认 300）
- `approvalViaWechat`（默认 true；false 时全部 `next()` 交回 GUI）

**改动文件**：新增 `src/approval.ts`（应答器+pending 管理）；`src/index.ts`（ensureAgent setup 注册、agent→accountId 反查 Map、daemon 内部 API `/api/approval/push`）；`src/bridge/commands/router.ts` + `handlers.ts`（`/yes` `/no` 命令）；`src/bridge/main.ts`（审批推送走批量发送通道但**跳过排队直接发**——审批是交互刚需）。
**验证**：单测（mock ctx + 假 daemon）；真机触发一个需要权限的工具调用。

### P0-3 证据型 README 重写（估 0.5 天）

学 gtaifu 的信任排版，但基于真实验证：

1. 顶部加 **30 秒演示 GIF**（见 P2-1，先占位）。
2. 「已验证」矩阵：登录 / 消息环 / 媒体收发 / 断线重连 / 会话 resume / `/stop` `/clear` 安全校验——逐项 ✅ + 验证日期，每次发版更新。
3. 「安全模型」章节：发送者校验 fail-closed、内部 API token 鉴权 + 仅回环、审批归属校验。
4. 「与同类方案对比」表（客观矩阵：审批 / Web 面板 / 三端守护 / 主动推送+节流 / 模型工具 / 崩溃恢复），只写已证实项。
5. 兼容性表（Node / DSH 版本 / 三端 OS，含最后验证日期）。

---

## 三、P1：体验差异化（目标 v0.5.0）

1. **上下文用量尾注**（估 1 天）：每轮回复附 `🧮 12.0k / 32.0k`，超 80% 提示 `/new`。
   - 待验证：token 用量数据源——查 session 事件流/agent 状态 API 是否暴露 usage；若无则附"轮数+历史长度"退化指标。
2. **多用户扫码配对 + 信任集**（估 2 天）：首人扫码自动信任（bootstrap）、后人面板确认、可吊销；会话/偏好 per-user 隔离。README 升级「安全模型」章节。
3. **崩溃安全加固**（估 2 天，吸收 LouisHaoL 封存教训）：
   - 跨进程轮询锁（`data/poll.lock`，带心跳，防双实例双写）
   - 入站消息 `message_id` 去重表（崩溃重投直接跳过）
   - 会话 resume 失败 → 隔离损坏映射 + 重建（我们已有 fallback，补"隔离留证"）
   - 完成后 README 可写"结构上崩溃安全"。
4. **媒体矩阵补齐 + 实测表**：入站语音转写状态、出站图片/视频，README 放方向×类型实测表。

## 四、P2：传播获客（持续，配合 market 上架）

1. **演示 GIF**：用 record-browser-gif 流程录「扫码→发消息→流式回复→面板管理」，`docs/screenshots/` 落 GitHub 托管图，README 顶部 + market 详情页。
2. **英文 README**（README.en.md，双语互链）。
3. **Gitee 镜像** + README 加镜像徽章。
4. **发文**：#2082 合并进 dsh-market 后，掘金/V2EX/即刻发实测文（带 GIF）。
5. market 上架资料复用对比表与 GIF。

## 五、不做清单（明确放弃）

- ❌ embedding 智能路由/多项目自动分流：LouisHaoL 已验证此路有竞态深坑并封存；我们主打"命令简单、行为可预测"。
- ❌ 现阶段扩 QQ/飞书：先把微信做到品类第一；多渠道写进 roadmap 即可。

## 六、版本与里程碑

| 版本 | 内容 | 发布动作 |
|---|---|---|
| v0.4.0 | P0-1 防卡死 + P0-2 审批 + P0-3 README | 走 TP 发布 SOP（tag → Actions） |
| v0.5.0 | P1-1 用量尾注 + P1-3 崩溃安全 | 同上 |
| v0.6.0 | P1-2 多用户 + P1-4 媒体矩阵 | 同上 + 发文 |

## 七、开放问题验证结果（2026-08-21 已核实）

1. ✅ **scoped `systemPrompt.section()` 只作用于该 agent**：`PromptLayer` 按 `ScopedLayers` 分层，官方注释明确"per-agent override 需经该 agent 的 `agent.ctx` 注册"，scoped 段落会遮蔽同名全局段落。
2. ❌ **`userQuestions.registerProvider` 不支持 scope 隔离**：provider 存在共享单例上，重复注册抛 `DUPLICATE_PROVIDER`。→ P0-1 采用提示词注入（已实现），微信原生问答不可行，放弃。
3. ⏳ token 用量数据源待查（P1-1 动工前再验证）。
4. ✅ **审批瀑布兜底**：监听者抛异常 → 归一化为 `'unavailable'`；`req.signal` 中断 → `'cancelled'`；永不 resolve 的监听者会一直挂到 signal 中断——所以我们自己的超时定时器是必需的（已实现，`settle` 与其不冲突）。

## 八、实施进度

- ✅ **v0.4.0（P0 全部完成，2026-08-21）**：P0-1 防卡死（scoped 提示词段落，`src/agent-setup.ts`）、P0-2 微信审批（`src/approval.ts` + daemon `/approval` 端点 + `/yes` `/no` 优先命令）、typecheck/build 全绿。P0-3 证据型 README 部分完成（功能清单已更新，「已验证」矩阵与对比表待真机验证后补）。
- ⏳ P1 / P2 未开始。
