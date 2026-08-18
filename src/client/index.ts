/**
 * @dsh-external/dsh-wechat-bridge — Web 管理面板。
 *
 * 渲染在 conversation.view 槽位，通过 DSH Web 同源路由读取/控制桥接状态。
 * conversation.view 要求 React 组件，因此这里注册的是 React 组件而不是 DOM 对象。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { WechatBridgePanel } from './Panel.js'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: '@dsh-external/dsh-wechat-bridge-panel',
      order: 30,
      label: () => '📱 微信桥接',
    }, WechatBridgePanel),
  ), '@dsh-external/dsh-wechat-bridge: panel')
}
