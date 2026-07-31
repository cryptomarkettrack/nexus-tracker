import { useEffect } from 'react'
import { CommandMode } from './components/command/CommandMode'
import { FocusMode } from './components/focus/FocusMode'
import { Shell } from './components/layout/Shell'
import { RadarMode } from './components/radar/RadarMode'
import { ScannerMode } from './components/scanner/ScannerMode'
import { useMarketStore } from './stores/marketStore'

export default function App() {
  const mode = useMarketStore((s) => s.mode)
  const bootstrap = useMarketStore((s) => s.bootstrap)
  const error = useMarketStore((s) => s.error)
  const connection = useMarketStore((s) => s.connection)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  return (
    <Shell>
      {error && connection === 'error' ? (
        <div className="mode-view">
          <div className="empty-state" style={{ color: 'var(--rose)' }}>
            Connection failed: {error}
            <br />
            <button
              className="chip active"
              style={{ marginTop: 16 }}
              onClick={() => void bootstrap()}
            >
              Retry
            </button>
          </div>
        </div>
      ) : (
        <>
          {mode === 'command' && <CommandMode />}
          {mode === 'scanner' && <ScannerMode />}
          {mode === 'radar' && <RadarMode />}
          {mode === 'focus' && <FocusMode />}
        </>
      )}
    </Shell>
  )
}
