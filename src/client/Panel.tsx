import type * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'

const API_BASE = '/@lanbaolu/dsh-wechat-bridge'

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
  alignItems: 'center',
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

const inputStyle: React.CSSProperties = {
  padding: '4px 8px',
  border: '1px solid var(--border-color, rgba(127,127,127,.4))',
  borderRadius: 6,
  background: 'var(--surface-3, rgba(127,127,127,.06))',
  color: 'var(--text-1, inherit)',
  fontSize: 12,
  minWidth: 220,
}

const hintStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  opacity: 0.7,
}

type SetupPhase = 'idle' | 'starting' | 'qr' | 'confirmed' | 'error'

export function WechatBridgePanel(_props: SettingsSectionOwnerProps): React.JSX.Element {
  const [output, setOutput] = useState('加载中…')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [workingDir, setWorkingDir] = useState('')
  const [setupPhase, setSetupPhase] = useState<SetupPhase>('idle')
  const [qrcodeDataUrl, setQrcodeDataUrl] = useState('')
  const [qrcodeId, setQrcodeId] = useState('')
  const [setupError, setSetupError] = useState('')
  const [boundAccountId, setBoundAccountId] = useState('')
  const [daemonMessage, setDaemonMessage] = useState('')

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/status`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setOutput(JSON.stringify(data, null, 2))
      if (typeof data.workingDirectory === 'string') {
        setWorkingDir((prev) => prev || data.workingDirectory)
      }
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

  async function startSetup(): Promise<void> {
    setSetupPhase('starting')
    setSetupError('')
    try {
      const res = await fetch(`${API_BASE}/setup/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDirectory: workingDir || undefined }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.message || data.error || '启动扫码绑定失败')
      setQrcodeDataUrl(data.qrcodeDataUrl)
      setQrcodeId(data.qrcodeId)
      setWorkingDir(data.workingDirectory || workingDir)
      setSetupPhase('qr')
    } catch (err) {
      setSetupPhase('error')
      setSetupError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    if (setupPhase !== 'qr' || !qrcodeId) return

    let cancelled = false
    let timer: number | undefined

    async function poll(): Promise<void> {
      try {
        const res = await fetch(`${API_BASE}/setup/status?qrcodeId=${encodeURIComponent(qrcodeId)}`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (cancelled) return

        if (data.status === 'confirmed') {
          setSetupPhase('confirmed')
          setBoundAccountId(data.accountId || '')
          setDaemonMessage(data.daemon || '')
          void refresh()
          return
        }

        if (data.status === 'expired' || (data.status === 'error' && !data.retryable)) {
          setSetupPhase('error')
          setSetupError(data.message || '绑定失败，请重试')
          return
        }

        timer = window.setTimeout(() => void poll(), 3000)
      } catch (err) {
        if (!cancelled) {
          setSetupPhase('error')
          setSetupError(err instanceof Error ? err.message : String(err))
        }
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [setupPhase, qrcodeId, refresh])

  function cancelSetup(): void {
    setSetupPhase('idle')
    setQrcodeDataUrl('')
    setQrcodeId('')
    setSetupError('')
    setDaemonMessage('')
  }

  const actions: Array<{ label: string; run: () => void; disabled?: boolean }> = [
    { label: '刷新状态', run: () => void refresh() },
    { label: '扫码绑定', run: () => void startSetup(), disabled: setupPhase === 'starting' || setupPhase === 'qr' },
    { label: '启动', run: () => void run('start'), disabled: busy !== null },
    { label: '停止', run: () => void run('stop'), disabled: busy !== null },
    { label: '重启', run: () => void run('restart'), disabled: busy !== null },
    { label: '查看日志', run: () => void showLogs(), disabled: busy !== null },
  ]

  return (
    <div style={panelStyle} role="region" aria-label="DSH 微信桥接管理面板">
      <div style={titleStyle}>📱 DSH 微信桥接</div>

      {error && <div role="alert" style={{ color: '#e5484d', marginBottom: 8 }}>{error}</div>}

      <label style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
        DSH 工作目录
        <input
          type="text"
          value={workingDir}
          onChange={(e) => setWorkingDir(e.target.value)}
          placeholder="例如 ~/Documents/DSH"
          style={{ ...inputStyle, marginLeft: 8 }}
        />
      </label>

      {setupPhase === 'starting' && (
        <div role="status" style={{ marginBottom: 8 }}>正在生成二维码…</div>
      )}

      {setupPhase === 'qr' && qrcodeDataUrl && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>请用微信扫描下方二维码完成绑定</div>
          <img
            src={qrcodeDataUrl}
            alt="微信扫码绑定二维码"
            width={240}
            height={240}
            style={{ display: 'block', maxWidth: '100%', height: 'auto', borderRadius: 8, background: '#fff' }}
          />
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
            工作目录：{workingDir || '未设置'}。等待扫码确认中…
          </div>
          <button type="button" style={{ ...buttonStyle, marginTop: 8 }} onClick={cancelSetup}>
            取消绑定
          </button>
        </div>
      )}

      {setupPhase === 'confirmed' && (
        <div role="status" style={{ marginBottom: 8, color: '#2f9e44' }}>
          ✅ 绑定成功{boundAccountId ? `：${boundAccountId}` : ''}，{daemonMessage || '桥接已自动重启/启动。'}
        </div>
      )}

      {setupPhase === 'error' && (
        <div role="alert" style={{ marginBottom: 8, color: '#e5484d' }}>
          ❌ {setupError}
          <button type="button" style={{ ...buttonStyle, marginLeft: 8 }} onClick={() => setSetupPhase('idle')}>
            重新扫码
          </button>
        </div>
      )}

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
        也可在 DSH 对话中直接使用 wechat_bridge_setup / wechat_bridge_status / wechat_bridge_start / wechat_bridge_stop / wechat_bridge_logs 等工具。
      </div>
    </div>
  )
}
