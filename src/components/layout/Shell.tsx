import type { ReactNode } from 'react'
import type { Mode } from '../../lib/types'
import { formatCompact, formatPrice } from '../../lib/indicators'
import { useMarketStore } from '../../stores/marketStore'
import { cn } from '../shared/utils'

const MODES: { id: Mode; label: string; icon: string }[] = [
  { id: 'command', label: 'CMD', icon: '⌘' },
  { id: 'scanner', label: 'SCAN', icon: '◎' },
  { id: 'radar', label: 'RADAR', icon: '▦' },
  { id: 'focus', label: 'FOCUS', icon: '◉' },
]

export function Shell({ children }: { children: ReactNode }) {
  const mode = useMarketStore((s) => s.mode)
  const setMode = useMarketStore((s) => s.setMode)
  const connection = useMarketStore((s) => s.connection)
  const tickerList = useMarketStore((s) => s.tickerList)
  const breadth = useMarketStore((s) => s.breadth)
  const regime = useMarketStore((s) => s.regime)
  const lastRefresh = useMarketStore((s) => s.lastRefresh)

  const btc = tickerList.find((t) => t.symbol === 'BTCUSDT')
  const eth = tickerList.find((t) => t.symbol === 'ETHUSDT')
  const totalVol = tickerList.slice(0, 100).reduce((a, t) => a + t.quoteVolume, 0)

  return (
    <div className="app-shell">
      <header className="header">
        <div className="brand">
          <div className="brand-mark">NX</div>
          <div className="brand-text">
            <div className="brand-name">NEXUS</div>
            <div className="brand-sub">Market Intelligence</div>
          </div>
        </div>

        <div className="header-stats">
          <div className="stat-pill">
            <div className="stat-label">BTC</div>
            <div className={cn('stat-value', (btc?.priceChangePercent ?? 0) >= 0 ? 'up' : 'down')}>
              {btc ? formatPrice(btc.lastPrice) : '—'}{' '}
              <span style={{ fontSize: 11 }}>
                {btc ? `${btc.priceChangePercent >= 0 ? '+' : ''}${btc.priceChangePercent.toFixed(2)}%` : ''}
              </span>
            </div>
          </div>
          <div className="stat-pill">
            <div className="stat-label">ETH</div>
            <div className={cn('stat-value', (eth?.priceChangePercent ?? 0) >= 0 ? 'up' : 'down')}>
              {eth ? formatPrice(eth.lastPrice) : '—'}{' '}
              <span style={{ fontSize: 11 }}>
                {eth ? `${eth.priceChangePercent >= 0 ? '+' : ''}${eth.priceChangePercent.toFixed(2)}%` : ''}
              </span>
            </div>
          </div>
          <div className="stat-pill">
            <div className="stat-label">Breadth</div>
            <div className={cn('stat-value', (breadth?.advancePct ?? 50) >= 50 ? 'up' : 'down')}>
              {breadth ? `${breadth.advancePct.toFixed(0)}% adv` : '—'}
            </div>
          </div>
          <div className="stat-pill">
            <div className="stat-label">Top-100 vol</div>
            <div className="stat-value amber">{formatCompact(totalVol)}</div>
          </div>
          <div className="stat-pill">
            <div className="stat-label">Regime</div>
            <div
              className={cn(
                'stat-value',
                regime?.bias === 'risk-on'
                  ? 'up'
                  : regime?.bias === 'risk-off'
                    ? 'down'
                    : 'amber',
              )}
            >
              {regime?.label ?? 'Bootstrapping…'}
            </div>
          </div>
        </div>

        <div className="header-right">
          <div className={cn('live-dot', connection)}>
            <i />
            {connection === 'live'
              ? 'Live WS'
              : connection === 'connecting'
                ? 'Connecting'
                : connection === 'error'
                  ? 'Error'
                  : connection}
          </div>
          <div className="stat-pill">
            <div className="stat-label">Sync</div>
            <div className="stat-value muted" style={{ fontSize: 11 }}>
              {lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : '—'}
            </div>
          </div>
        </div>
      </header>

      <nav className="rail">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={cn('rail-btn', mode === m.id && 'active')}
            onClick={() => setMode(m.id)}
            title={m.id}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>{m.icon}</span>
            <span>{m.label}</span>
          </button>
        ))}
      </nav>

      <main className="main">{children}</main>
    </div>
  )
}
