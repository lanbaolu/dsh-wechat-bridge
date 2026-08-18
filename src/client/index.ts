/**
 * @lanbaolu/dsh-wechat-bridge — Web 管理面板。
 *
 * 渲染在 settings.section 槽位（设置页），不绑定具体会话，打开任何任务前都可通过
 * 侧边栏 Settings 进入；通过 DSH Web 同源路由读取/控制桥接状态。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { WechatBridgePanel } from './Panel.js'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: '@lanbaolu/dsh-wechat-bridge-panel',
      order: 55,
      label: () => '📱 微信桥接',
    }, WechatBridgePanel),
  ), '@lanbaolu/dsh-wechat-bridge: panel')
}
