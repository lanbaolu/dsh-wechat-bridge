/**
 * 微信审批管理器（host 侧）。
 *
 * 把 DSH 内核的 `approval/request` 瀑布事件桥到微信：agent 请求权限时推一条
 * 审批消息到手机，用户回复 /yes /no 即完成裁决。设计原则：
 *
 * - fail-closed：超时、daemon 不可达、请求被撤销时都收敛到拒绝/交回其他应答器，
 *   绝不静默放行，也绝不把审批悬到永远。
 * - 单 pending：同一账号同一时刻只有一条待审批，新请求直接 `next()` 交回
 *   瀑布下游（如桌面 GUI），避免多条审批在微信里错乱堆叠。
 * - 归属严格：decide 只裁决本账号的 pending（daemon 侧已按 from_user_id 校验
 *   发送者，双保险）。
 */

/** DSH approval 服务的裁决词表（与 @deepseek-ai/dsh-user-approval 一致）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** approval/request 事件里我们用到的字段（本地最小结构，避免硬依赖包类型）。 */
export interface ApprovalRequestLike {
  readonly toolName: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

export type ApprovalNext = () => Promise<ApprovalOutcome>

export interface ApprovalManagerDeps {
  /** 审批等待超时（毫秒）。 */
  timeoutMs: number
  /**
   * 推送一条紧急消息到绑定的微信；daemon 不可达时 resolve false。
   * `key` 是审批归属的 session key（多用户下 = ${botAccountId}::${userId}），
   * 调用方据此把审批推给发起任务的用户本人。
   */
  push: (text: string, key: string) => Promise<boolean>
  log?: (message: string, data?: unknown) => void
}

export interface ApprovalDecisionResult {
  ok: boolean
  reason?: 'no-pending'
  toolName?: string
}

interface PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
  toolName: string
  onAbort?: () => void
}

export interface ApprovalManager {
  /** approval/request 瀑布监听器入口。 */
  handleRequest(accountId: string, req: ApprovalRequestLike, next: ApprovalNext): Promise<ApprovalOutcome>
  /** 用户回复 /yes /no 时由内部 API 调用。 */
  decide(accountId: string, approved: boolean): ApprovalDecisionResult
  hasPending(accountId: string): boolean
  dispose(): void
}

export function formatApprovalText(req: ApprovalRequestLike, timeoutMs: number): string {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
  return [
    '⚠️ DSH 任务需要你的批准',
    '',
    `工具：${req.toolName}`,
    `原因：${req.reason?.trim() || '（未提供说明）'}`,
    '',
    '回复 /yes 批准，/no 拒绝。',
    `${minutes} 分钟内未回复将自动拒绝。`,
  ].join('\n')
}

export function createApprovalManager(deps: ApprovalManagerDeps): ApprovalManager {
  const pending = new Map<string, PendingApproval>()
  const log = deps.log ?? (() => {})

  function settle(accountId: string, entry: PendingApproval, outcome: ApprovalOutcome): void {
    // 身份比对：map 里可能已是另一条更新的 pending，不能误删。
    if (pending.get(accountId) !== entry) return
    pending.delete(accountId)
    clearTimeout(entry.timer)
    entry.resolve(outcome)
  }

  async function handleRequest(
    accountId: string,
    req: ApprovalRequestLike,
    next: ApprovalNext,
  ): Promise<ApprovalOutcome> {
    if (pending.has(accountId)) {
      log('approval already pending, hand off to next answerer', { accountId, toolName: req.toolName })
      return next()
    }

    // pending 必须先于 push 同步登记：否则并发第二请求会在 push 的 await
    // 窗口内同样通过 has() 检查，两条审批互相覆盖丢失。
    let entry!: PendingApproval
    const promise = new Promise<ApprovalOutcome>((resolve) => {
      entry = {
        resolve,
        toolName: req.toolName,
        timer: setTimeout(() => {
          settle(accountId, entry, 'rejected')
          log('approval timed out, auto-rejected', { accountId, toolName: req.toolName })
          void deps.push(`⏱ 审批超时，已自动拒绝：${req.toolName}`, accountId).catch(() => false)
        }, deps.timeoutMs),
      }
      // 请求方撤销（如任务被 /stop）：立即收敛，迟到回复不再有效。
      if (req.signal) {
        const onAbort = () => settle(accountId, entry, 'cancelled')
        entry.onAbort = onAbort
        if (req.signal.aborted) settle(accountId, entry, 'cancelled')
        else req.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    pending.set(accountId, entry)

    const delivered = await deps.push(formatApprovalText(req, deps.timeoutMs), accountId).catch(() => false)
    if (!delivered) {
      // 推送失败：撤销 pending（清理定时器与信号监听）并交回瀑布下游。
      if (pending.get(accountId) === entry) pending.delete(accountId)
      clearTimeout(entry.timer)
      if (req.signal && entry.onAbort) req.signal.removeEventListener('abort', entry.onAbort)
      log('approval push failed, hand off to next answerer', { accountId, toolName: req.toolName })
      return next()
    }

    log('approval pushed to wechat', { accountId, toolName: req.toolName })
    return promise
  }

  function decide(accountId: string, approved: boolean): ApprovalDecisionResult {
    const entry = pending.get(accountId)
    if (!entry) return { ok: false, reason: 'no-pending' }
    const toolName = entry.toolName
    settle(accountId, entry, approved ? 'allowed-once' : 'rejected')
    log('approval decided via wechat', { accountId, toolName, approved })
    return { ok: true, toolName }
  }

  function hasPending(accountId: string): boolean {
    return pending.has(accountId)
  }

  function dispose(): void {
    for (const [accountId, entry] of [...pending]) {
      settle(accountId, entry, 'cancelled')
    }
  }

  return { handleRequest, decide, hasPending, dispose }
}
