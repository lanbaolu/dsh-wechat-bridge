/**
 * @dsh-external/dsh-wechat-bridge — Web 管理面板。
 *
 * 渲染在 conversation.view 槽位，通过 DSH Web 同源路由读取/控制桥接状态。
 * 纯 DOM 实现，不引入 React 依赖。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

export const inject = ['slots']

const API_BASE = '/@dsh-external/dsh-wechat-bridge'

function createPanel(): HTMLElement {
  const root = document.createElement('div')
  root.className = 'dsh-wechat-bridge-panel'
  root.style.cssText = `
    padding: 14px 16px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.6;
    color: #1f2328;
    background: rgba(127,127,127,.06);
    border: 1px solid rgba(127,127,127,.18);
    border-radius: 10px;
    margin: 8px 0;
  `

  const title = document.createElement('div')
  title.textContent = '📱 DSH 微信桥接'
  title.style.cssText = 'font-weight: 600; font-size: 14px; margin-bottom: 8px;'

  const status = document.createElement('pre')
  status.style.cssText = `
    margin: 4px 0 8px;
    padding: 8px 10px;
    background: rgba(0,0,0,.04);
    border-radius: 6px;
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 12px;
  `
  status.textContent = '加载中…'

  const buttons = document.createElement('div')
  buttons.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;'

  function button(label: string, action?: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.textContent = label
    btn.type = 'button'
    btn.style.cssText = `
      padding: 4px 10px;
      border: 1px solid rgba(127,127,127,.4);
      border-radius: 6px;
      background: #fff;
      cursor: pointer;
      font-size: 12px;
    `
    btn.addEventListener('click', async () => {
      btn.disabled = true
      try {
        await action?.()
      } finally {
        btn.disabled = false
      }
    })
    return btn
  }

  async function refresh(): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/status`, { cache: 'no-store' })
      const data = await res.json()
      status.textContent = JSON.stringify(data, null, 2)
    } catch (err) {
      status.textContent = `读取状态失败: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  async function run(path: string): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/${path}`, { method: 'POST' })
      const data = await res.json()
      status.textContent = JSON.stringify(data, null, 2)
    } catch (err) {
      status.textContent = `操作失败: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      await refresh()
    }
  }

  buttons.append(
    button('刷新状态', refresh),
    button('启动', () => run('start')),
    button('停止', () => run('stop')),
    button('重启', () => run('restart')),
    button('查看日志', async () => {
      try {
        const res = await fetch(`${API_BASE}/logs`, { cache: 'no-store' })
        status.textContent = await res.text()
      } catch (err) {
        status.textContent = `读取日志失败: ${err instanceof Error ? err.message : String(err)}`
      }
    }),
  )

  const hint = document.createElement('div')
  hint.textContent = '也可在 DSH 对话中直接使用 wechat_bridge_status / wechat_bridge_start / wechat_bridge_stop / wechat_bridge_logs 等工具。'
  hint.style.cssText = 'margin-top: 8px; font-size: 12px; opacity: .7;'

  root.append(title, status, buttons, hint)
  void refresh()
  return root
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: '@dsh-external/dsh-wechat-bridge-panel',
      label: () => '@dsh-external/dsh-wechat-bridge',
    }, () => ({
      render() {
        return createPanel()
      },
    })),
  ), '@dsh-external/dsh-wechat-bridge: panel')
}
