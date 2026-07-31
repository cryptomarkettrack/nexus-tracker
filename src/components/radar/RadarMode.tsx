import { useMemo } from 'react'
import { formatCompact, formatPct } from '../../lib/indicators'
import { useMarketStore } from '../../stores/marketStore'
import { Panel, Pct } from '../shared/utils'

function heatColor(change: number): string {
  // map -8%..+8% to rose → neutral → lime
  const t = Math.max(-1, Math.min(1, change / 8))
  if (t >= 0) {
    const a = 0.15 + t * 0.65
    return `rgba(143, 186, 107, ${a})`
  }
  const a = 0.15 + Math.abs(t) * 0.65
  return `rgba(212, 93, 93, ${a})`
}

export function RadarMode() {
  const tickerList = useMarketStore((s) => s.tickerList)
  const sectors = useMarketStore((s) => s.sectors)
  const metrics = useMarketStore((s) => s.metrics)
  const setFocusSymbol = useMarketStore((s) => s.setFocusSymbol)
  const breadth = useMarketStore((s) => s.breadth)

  const heat = useMemo(() => {
    return tickerList.slice(0, 72)
  }, [tickerList])

  const rsLeaders = useMemo(
    () => [...metrics].sort((a, b) => b.relStrengthBtc - a.relStrengthBtc).slice(0, 12),
    [metrics],
  )
  const rsLaggards = useMemo(
    () => [...metrics].sort((a, b) => a.relStrengthBtc - b.relStrengthBtc).slice(0, 12),
    [metrics],
  )

  return (
    <div className="mode-view">
      <div className="grid-radar" style={{ minHeight: 'calc(100vh - 90px)' }}>
        <Panel
          title="Return heatmap"
          meta="top 72 by quote volume · 24h %"
          className="span-1"
          style={{ gridColumn: '1 / -1' } as React.CSSProperties}
        >
          <div className="heatmap">
            {heat.map((t) => (
              <button
                key={t.symbol}
                className="heat-cell"
                style={{ background: heatColor(t.priceChangePercent), color: '#f2ebe0' }}
                onClick={() => setFocusSymbol(t.symbol)}
                title={`${t.base} ${formatPct(t.priceChangePercent)} · vol ${formatCompact(t.quoteVolume)}`}
              >
                <div className="heat-base">{t.base}</div>
                <div>
                  <div className="heat-chg">
                    {t.priceChangePercent >= 0 ? '+' : ''}
                    {t.priceChangePercent.toFixed(2)}%
                  </div>
                  <div className="heat-vol">{formatCompact(t.quoteVolume)}</div>
                </div>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="Sector board" meta="rotation">
          <div className="sector-grid">
            {sectors.map((s) => (
              <div key={s.id} className="sector-card">
                <div className="sector-name">{s.name}</div>
                <div className={`sector-chg ${s.avgChange >= 0 ? 'up' : 'down'}`}>
                  {formatPct(s.avgChange)}
                </div>
                <div className="bar-track" style={{ marginBottom: 8 }}>
                  <div
                    className={`bar-fill ${s.avgChange >= 0 ? 'up' : 'down'}`}
                    style={{
                      width: `${Math.min(100, Math.abs(s.avgChange) * 12)}%`,
                    }}
                  />
                </div>
                <div className="sector-meta">
                  {s.symbols.length} names · {formatCompact(s.totalVolume)}
                  <br />
                  ▲ {s.leaders.join(', ')}
                  <br />
                  ▼ {s.laggards.join(', ')}
                </div>
              </div>
            ))}
          </div>
          {breadth && (
            <div className="insight" style={{ marginTop: 12 }}>
              Market breadth: <strong>{breadth.advancePct.toFixed(0)}%</strong> advancing · median{' '}
              <strong>{formatPct(breadth.medianChange)}</strong> · up/down volume ratio{' '}
              <strong>
                {breadth.volumeDown > 0
                  ? (breadth.volumeUp / breadth.volumeDown).toFixed(2)
                  : '∞'}
              </strong>
            </div>
          )}
        </Panel>

        <Panel title="Relative strength vs BTC" meta="alpha surface">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div className="filter-label">Outperformers</div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th className="num">RS</th>
                    <th className="num">24h</th>
                  </tr>
                </thead>
                <tbody>
                  {rsLeaders.map((m) => (
                    <tr key={m.symbol} onClick={() => setFocusSymbol(m.symbol)}>
                      <td>
                        <strong>{m.base}</strong>
                      </td>
                      <td className="num">
                        <Pct value={m.relStrengthBtc} />
                      </td>
                      <td className="num muted">
                        <Pct value={m.change24h} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <div className="filter-label">Underperformers</div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th className="num">RS</th>
                    <th className="num">24h</th>
                  </tr>
                </thead>
                <tbody>
                  {rsLaggards.map((m) => (
                    <tr key={m.symbol} onClick={() => setFocusSymbol(m.symbol)}>
                      <td>
                        <strong>{m.base}</strong>
                      </td>
                      <td className="num">
                        <Pct value={m.relStrengthBtc} />
                      </td>
                      <td className="num muted">
                        <Pct value={m.change24h} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  )
}
