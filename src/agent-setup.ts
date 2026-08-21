/**
 * 微信桥 agent 的作用域装配（AgentSetup）。
 *
 * 通过 `agents.create/resume` 的 `setup` 钩子在 agent 公布前注入：
 *  1. scoped 提示词段落——告诉模型这是微信纯文本通道，禁用交互式选项工具
 *     （选项只弹在电脑浏览器，微信用户永远看不到，agent 会永久阻塞）；
 *  2. scoped `approval/request` 监听器——把权限请求桥到微信审批。
 *
 * 两者都注册在 agent 自己的作用域上（scope 过滤），不影响桌面 GUI 会话。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import type { ApprovalManager, ApprovalNext, ApprovalOutcome, ApprovalRequestLike } from './approval.js'

/** 微信通道提示词段落名（scoped 注册，与同名的全局段落互不影响）。 */
export const WECHAT_CHANNEL_SECTION = 'wechat-bridge-channel'

/**
 * 微信通道行为约束。order 150 落在工具指导段（100–199）区间。
 * 这段文字会在每次提示词装配时进入该 agent 的系统提示词。
 */
export const WECHAT_CHANNEL_PROMPT = [
  '你正在通过「微信桥」与用户对话：用户在手机微信里收发消息，只能看到纯文本，看不到电脑屏幕。',
  '绝对不要使用交互式选项/提问工具（如 ask_user_question）：选项界面只会弹在电脑浏览器上，微信里的用户看不到也无法点击，调用后你会永久卡住、回复永远发不出去。',
  '需要用户做选择或确认时，直接用纯文本列出编号选项（1. 2. 3.），以问句结尾等待用户用普通消息回复数字或文字，然后继续。',
  '你接入了跨会话记忆库：当用户提到过去的决定、项目状态、偏好（例如"某某插件是不是卸载了"），而你不能确定时，先调用 memory_search 查证再回答，不要仅凭本会话上下文猜测。',
  '回复尽量分段清晰、适合手机阅读；长内容先说结论。',
].join('\n')

interface SystemPromptLike {
  section?: (section: { name: string; order: number; text: string }) => unknown
}

export interface WechatAgentSetupDeps {
  accountId: string
  /** 未启用微信审批（approvalViaWechat=false）时为 undefined。 */
  approval?: ApprovalManager
  log?: (message: string, data?: unknown) => void
}

interface AgentPresetsLike {
  mount?: (agentCtx: Context, id?: string) => Promise<{ id?: string } | unknown>
}

export function createWechatAgentSetup(deps: WechatAgentSetupDeps): AgentSetup {
  const log = deps.log ?? (() => {})
  return async (agentCtx: Context) => {
    // 必须挂载部署默认 preset：不挂的话工具/技能/提示词全部退化到空全局层
    // （dsh-agent-presets 会告警 "published without joining an agent preset"），
    // shell 等 preset 提供的工具拿不到，审批流也无从触发。
    try {
      const presets = agentCtx.get('agentPresets') as AgentPresetsLike | undefined
      if (presets?.mount) {
        const mounted = await presets.mount(agentCtx)
        log('agent preset mounted', {
          accountId: deps.accountId,
          preset: (mounted as { id?: string } | undefined)?.id,
        })
      } else {
        log('agentPresets service unavailable, agent stays on global layer', { accountId: deps.accountId })
      }
    } catch (err) {
      log('agent preset mount failed (agent falls back to global layer)', {
        accountId: deps.accountId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    try {
      const systemPrompt = agentCtx.get('systemPrompt') as SystemPromptLike | undefined
      systemPrompt?.section?.({ name: WECHAT_CHANNEL_SECTION, order: 150, text: WECHAT_CHANNEL_PROMPT })
    } catch (err) {
      log('systemPrompt section registration failed', {
        accountId: deps.accountId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    if (deps.approval) {
      const approval = deps.approval
      try {
        // dsh-user-approval 的 Events 增强未必在本插件的类型链里，这里用最小结构注册。
        const on = (agentCtx as unknown as {
          on: (event: 'approval/request', listener: (req: ApprovalRequestLike, next: ApprovalNext) => Promise<ApprovalOutcome>) => void
        }).on
        on.call(agentCtx, 'approval/request', (req, next) => approval.handleRequest(deps.accountId, req, next))
      } catch (err) {
        log('approval listener registration failed', {
          accountId: deps.accountId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
}
