import { useMemo, useState } from 'react'
import { formatCompact, formatPrice } from '../../lib/indicators'
import type { CoinMetrics } from '../../lib/types'
import { useMarketStore } from '../../stores/marketStore'
import { Panel, Pct, cn } from '../shared/utils'

type ScannerFilter = ReturnType<typeof useMarketStore.getState>['scannerFilter']

const FILTERS: { id: ScannerFilter; label: string; hint: string }[] = [
  { id: 'all', label: 'All signals', hint: 'Ranked by setup score' },
  { id: 'breakout', label: 'Breakouts', hint: 'Vol + near highs' },
  { id: 'volume-spike', label: 'Vol spikes', hint: 'Unusual participation' },
  { id: 'strength', label: 'Rel. strength', hint: 'Beating BTC' },
  { id: 'mean-reversion', label: 'Reversions', hint: 'RSI extremes' },
  { id: 'squeeze', label: 'Squeezes', hint: 'Quiet coil' },
]

export function ScannerMode() {
  const metrics = useMarketStore((s) => s.metrics)
  const scannerFilter = useMarketStore((s) => s.scannerFilter)
  const setScannerFilter = useMarketStore((s) => s.setScannerFilter)
  const setFocusSymbol = useMarketStore((s) => s.setFocusSymbol)
  const focusSymbol = useMarketStore((s) => s.focusSymbol)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'score' | 'vol' | 'change' | 'rs' | 'rsi'>('score')

  const rows = useMemo(() => {
    let list: CoinMetrics[] = metrics
    if (scannerFilter !== 'all') {
      list = list.filter((m) => m.setup === scannerFilter)
    }
    if (q.trim()) {
      const qq = q.trim().toUpperCase()
      list = list.filter((m) => m.base.includes(qq) || m.symbol.includes(qq))
    }
    const sorted = [...list]
    switch (sort) {
      case 'vol':
        sorted.sort((a, b) => b.volumeAnomaly - a.volumeAnomaly)
        break
      case 'change':
        sorted.sort((a, b) => b.change24h - a.change24h)
        break
      case 'rs':
        sorted.sort((a, b) => b.relStrengthBtc - a.relStrengthBtc)
        break
      case 'rsi':
        sorted.sort((a, b) => a.rsi - b.rsi)
        break
      default:
        sorted.sort((a, b) => b.setupScore - a.setupScore)
    }
    return sorted
  }, [metrics, scannerFilter, q, sort])

  const topInsight = rows[0]

  return (
    <div className="mode-view">
      <div className="grid-scanner" style={{ minHeight: 'calc(100vh - 90px)' }}>
        <Panel title="Lens" meta="filters">
          <div className="filters">
            <input
              className="search-input"
              placeholder="Filter symbol…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div>
              <div className="filter-label">Setup type</div>
              <div className="chip-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    className={cn('chip', scannerFilter === f.id && 'active')}
                    style={{ textAlign: 'left' }}
                    onClick={() => setScannerFilter(f.id)}
                  >
                    <div>{f.label}</div>
                    <div className="muted" style={{ fontSize: 9, marginTop: 2 }}>
                      {f.hint}
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="filter-label">Sort</div>
              <div className="chip-row">
                {(
                  [
                    ['score', 'Score'],
                    ['vol', 'Vol×'],
                    ['change', '24h'],
                    ['rs', 'vs BTC'],
                    ['rsi', 'RSI'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    className={cn('chip', sort === id && 'active')}
                    onClick={() => setSort(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="insight" style={{ marginTop: 8 }}>
              <strong>How to read this</strong>
              <br />
              Scanner ranks liquid USDT pairs by confluence of volume anomaly, relative strength
              vs BTC, RSI posture, and range position. Click a row to open FOCUS with S/R and
              volume profile.
            </div>
          </div>
        </Panel>

        <Panel
          title="Opportunity matrix"
          meta={`${rows.length} names`}
          bodyClassName="scroll-y"
          className="grow"
        >
          {topInsight && (
            <div className="insight">
              <strong>Top pick · {topInsight.base}</strong> — {topInsight.setupReason} · RSI{' '}
              {topInsight.rsi.toFixed(0)} · range pos {(topInsight.rangePosition * 100).toFixed(0)}%
              · ATR {topInsight.atrPct.toFixed(2)}%
            </div>
          )}
          {rows.length === 0 ? (
            <div className="empty-state">No matches — wait for candle enrichment or clear filters</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Coin</th>
                  <th>Setup</th>
                  <th className="num">Score</th>
                  <th className="num">Price</th>
                  <th className="num">24h</th>
                  <th className="num">vs BTC</th>
                  <th className="num">Vol×</th>
                  <th className="num">RSI</th>
                  <th className="num">Range</th>
                  <th className="num">ATR%</th>
                  <th className="num">Quote vol</th>
                  <th>Thesis</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr
                    key={m.symbol}
                    className={cn(focusSymbol === m.symbol && 'active')}
                    onClick={() => setFocusSymbol(m.symbol)}
                  >
                    <td>
                      <strong style={{ fontFamily: 'var(--font-ui)' }}>{m.base}</strong>
                    </td>
                    <td>
                      <span className={`tag ${m.setup}`}>{m.setup}</span>
                    </td>
                    <td className="num amber">{m.setupScore.toFixed(0)}</td>
                    <td className="num">{formatPrice(m.price)}</td>
                    <td className="num">
                      <Pct value={m.change24h} />
                    </td>
                    <td className="num">
                      <Pct value={m.relStrengthBtc} />
                    </td>
                    <td className="num">{m.volumeAnomaly.toFixed(2)}</td>
                    <td
                      className={cn(
                        'num',
                        m.rsi > 70 ? 'down' : m.rsi < 30 ? 'up' : 'muted',
                      )}
                    >
                      {m.rsi.toFixed(0)}
                    </td>
                    <td className="num" style={{ minWidth: 72 }}>
                      <div className="bar-track">
                        <div
                          className="bar-fill teal"
                          style={{ width: `${Math.max(4, m.rangePosition * 100)}%` }}
                        />
                      </div>
                    </td>
                    <td className="num muted">{m.atrPct.toFixed(2)}</td>
                    <td className="num muted">{formatCompact(m.quoteVolume)}</td>
                    <td className="muted" style={{ maxWidth: 220, whiteSpace: 'normal' }}>
                      {m.setupReason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  )
}
