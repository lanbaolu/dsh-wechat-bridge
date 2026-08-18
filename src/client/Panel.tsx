import type * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'

const API_BASE = '/@dsh-external/dsh-wechat-bridge'

const panelStyle: React.CSSProperties = {
  padding: '14px 16px',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--text-1, #1f2328)',
  background: 'var(--surface-2, rgba(127,127,127,.06))',
  border: '1px solid var(--border-color, rgba(127,127,127,.18))',
  borderRadius: 10,
  margin: '8px 0',
}

const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  marginBottom: 8,
}

const outputStyle: React.CSSProperties = {
  margin: '4px 0 8px',
  padding: '8px 10px',
  background: 'var(--surface-3, rgba(0,0,0,.04))',
  border: '1px solid var(--border-color, rgba(127,127,127,.15))',
  borderRadius: 6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  maxHeight: 360,
  overflow: 'auto',
}

const buttonRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
}

const buttonStyle: React.CSSProperties = {
  padding: '4px 10px',
  border: '1px solid var(--border-color, rgba(127,127,127,.4))',
  borderRadius: 6,
  background: 'var(--button-bg, #fff)',
  color: 'var(--text-1, inherit)',
  cursor: 'pointer',
  fontSize: 12,
}

const hintStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  opacity: 0.7,
}

export function WechatBridgePanel(_props: SettingsSectionOwnerProps): React.JSX.Element {
  const [output, setOutput] = useState('加载中…')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/status`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setOutput(JSON.stringify(data, null, 2))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function run(path: string): Promise<void> {
    setBusy(path)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/${path}`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setOutput(JSON.stringify(data, null, 2))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function showLogs(): Promise<void> {
    setBusy('logs')
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/logs`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setOutput(await res.text())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const actions: Array<{ label: string; run: () => void; disabled?: boolean }> = [
    { label: '刷新状态', run: () => void refresh() },
    { label: '启动', run: () => void run('start'), disabled: busy !== null },
    { label: '停止', run: () => void run('stop'), disabled: busy !== null },
    { label: '重启', run: () => void run('restart'), disabled: busy !== null },
    { label: '查看日志', run: () => void showLogs(), disabled: busy !== null },
  ]

  return (
    <div style={panelStyle} role="region" aria-label="DSH 微信桥接管理面板">
      <div style={titleStyle}>📱 DSH 微信桥接</div>
      {error && <div role="alert" style={{ color: '#e5484d', marginBottom: 8 }}>{error}</div>}
      <pre style={outputStyle} aria-live="polite">{output}</pre>
      <div style={buttonRowStyle}>
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            style={buttonStyle}
            disabled={action.disabled ?? false}
            onClick={action.run}
          >
            {action.label}
          </button>
        ))}
      </div>
      <div style={hintStyle}>
        也可在 DSH 对话中直接使用 wechat_bridge_status / wechat_bridge_start / wechat_bridge_stop / wechat_bridge_logs 等工具。
      </div>
    </div>
  )
}
