import { formatCompact, formatPct, formatPrice } from '../../lib/indicators'
import { useMarketStore } from '../../stores/marketStore'
import { Panel, Pct, cn } from '../shared/utils'

const QUICK_ACCESS = [
  { base: 'BTC', symbol: 'BTCUSDT' },
  { base: 'ETH', symbol: 'ETHUSDT' },
  { base: 'NEXO', symbol: 'NEXOUSDT' },
  { base: 'ONDO', symbol: 'ONDOUSDT' },
] as const

export function CommandMode() {
  const regime = useMarketStore((s) => s.regime)
  const breadth = useMarketStore((s) => s.breadth)
  const metrics = useMarketStore((s) => s.metrics)
  const funding = useMarketStore((s) => s.funding)
  const sectors = useMarketStore((s) => s.sectors)
  const watchLevels = useMarketStore((s) => s.watchLevels)
  const tickerList = useMarketStore((s) => s.tickerList)
  const setFocusSymbol = useMarketStore((s) => s.setFocusSymbol)

  const moversUp = [...tickerList].sort((a, b) => b.priceChangePercent - a.priceChangePercent).slice(0, 8)
  const moversDown = [...tickerList].sort((a, b) => a.priceChangePercent - b.priceChangePercent).slice(0, 8)
  const volLeaders = tickerList.slice(0, 10)

  const setups = metrics
    .filter((m) => m.setup !== 'neutral' && m.setupScore >= 50)
    .slice(0, 10)

  const fundingList = [...funding.values()]
    .filter((f) => f.symbol.endsWith('USDT'))
    .sort((a, b) => Math.abs(b.fundingRate) - Math.abs(a.fundingRate))
    .slice(0, 8)

  const nearLevels = watchLevels
    .filter((w) => Math.abs(w.distancePct) < 2.5)
    .slice(0, 10)

  const volSpike = [...metrics].sort((a, b) => b.volumeAnomaly - a.volumeAnomaly).slice(0, 6)

  const quick = QUICK_ACCESS.map((q) => ({
    ...q,
    ticker: tickerList.find((t) => t.symbol === q.symbol),
  }))

  return (
    <div className="mode-view">
      <div className="quick-access">
        <div className="quick-access__label">Quick access</div>
        <div className="quick-access__row">
          {quick.map((q) => {
            const chg = q.ticker?.priceChangePercent
            return (
              <button
                key={q.symbol}
                type="button"
                className="quick-access__card"
                onClick={() => setFocusSymbol(q.symbol)}
              >
                <div className="quick-access__base">{q.base}</div>
                <div className="quick-access__price">
                  {q.ticker ? formatPrice(q.ticker.lastPrice) : '—'}
                </div>
                <div
                  className={cn(
                    'quick-access__chg',
                    chg == null ? 'muted' : chg >= 0 ? 'up' : 'down',
                  )}
                >
                  {chg == null ? '…' : formatPct(chg)}
                </div>
                <div className="quick-access__hint">Open focus →</div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid-command">
        <Panel title="Market regime" meta="multi-factor" className="span-1">
          <div className={`regime-card ${regime?.bias ?? 'mixed'}`}>
            <div className="regime-label">{regime?.label ?? 'Calibrating…'}</div>
            <div className="muted" style={{ marginBottom: 10, fontSize: 11 }}>
              Score {regime ? regime.score.toFixed(1) : '—'} · bias{' '}
              <span className="amber">{regime?.bias ?? '—'}</span>
            </div>
            <ul className="driver-list">
              {(regime?.drivers ?? ['Waiting for market snapshot…']).map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </div>
          {breadth && (
            <div className="kpi-row" style={{ marginTop: 10 }}>
              <div className="kpi">
                <div className="kpi-label">Advance</div>
                <div className="kpi-value up">{breadth.advancing}</div>
                <div className="kpi-sub">{breadth.advancePct.toFixed(1)}% of book</div>
              </div>
              <div className="kpi">
                <div className="kpi-label">Decline</div>
                <div className="kpi-value down">{breadth.declining}</div>
                <div className="kpi-sub">median {formatPct(breadth.medianChange)}</div>
              </div>
              <div className="kpi">
                <div className="kpi-label">Avg Δ</div>
                <div className={`kpi-value ${breadth.avgChange >= 0 ? 'up' : 'down'}`}>
                  {formatPct(breadth.avgChange)}
                </div>
                <div className="kpi-sub">{breadth.total} pairs</div>
              </div>
              <div className="kpi">
                <div className="kpi-label">Vol bias</div>
                <div className="kpi-value amber">
                  {breadth.volumeDown > 0
                    ? (breadth.volumeUp / breadth.volumeDown).toFixed(2)
                    : '∞'}
                </div>
                <div className="kpi-sub">up/down quote vol</div>
              </div>
            </div>
          )}
        </Panel>

        <Panel title="Actionable setups" meta="scored opportunities">
          {setups.length === 0 ? (
            <div className="empty-state">Enriching candles for setup detection…</div>
          ) : (
            <div className="scroll-y" style={{ maxHeight: 280 }}>
              {setups.map((m) => (
                <div
                  key={m.symbol}
                  className="level-row"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setFocusSymbol(m.symbol)}
                >
                  <div>
                    <div className="row-flex" style={{ marginBottom: 3 }}>
                      <strong style={{ fontFamily: 'var(--font-ui)' }}>{m.base}</strong>
                      <span className={`tag ${m.setup}`}>{m.setup}</span>
                      <span className="muted">score {m.setupScore.toFixed(0)}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 10, maxWidth: 280 }}>
                      {m.setupReason}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="num">{formatPrice(m.price)}</div>
                    <Pct value={m.change24h} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Near key levels" meta="±2.5% of S/R · POC">
          {nearLevels.length === 0 ? (
            <div className="empty-state">Building level map from 1h structure…</div>
          ) : (
            <div className="scroll-y" style={{ maxHeight: 280 }}>
              {nearLevels.map((w) => (
                <div
                  key={`${w.symbol}-${w.level}-${w.type}`}
                  className="level-row"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setFocusSymbol(w.symbol)}
                >
                  <div className="row-flex">
                    <strong style={{ fontFamily: 'var(--font-ui)', minWidth: 48 }}>{w.base}</strong>
                    <span className={`level-type ${w.type}`}>{w.type}</span>
                  </div>
                  <div className="num">{formatPrice(w.level)}</div>
                  <div className={w.side === 'above' ? 'down' : 'up'}>
                    {w.distancePct >= 0 ? '+' : ''}
                    {w.distancePct.toFixed(2)}%
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Sector rotation" meta="curated buckets" className="span-2">
          <div className="sector-grid">
            {sectors.map((s) => (
              <div key={s.id} className="sector-card">
                <div className="sector-name">{s.name}</div>
                <div className={`sector-chg ${s.avgChange >= 0 ? 'up' : 'down'}`}>
                  {formatPct(s.avgChange)}
                </div>
                <div className="sector-meta">
                  vol {formatCompact(s.totalVolume)}
                  <br />
                  lead {s.leaders.join(' · ') || '—'}
                  <br />
                  lag {s.laggards.join(' · ') || '—'}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Funding extremes" meta="USDT-M perps">
          {fundingList.length === 0 ? (
            <div className="empty-state">Loading futures premium index…</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Pair</th>
                    <th className="num">Funding</th>
                    <th className="num">Mark</th>
                  </tr>
                </thead>
                <tbody>
                  {fundingList.map((f) => (
                    <tr key={f.symbol} onClick={() => setFocusSymbol(f.symbol)}>
                      <td>{f.symbol.replace('USDT', '')}</td>
                      <td className={`num ${f.fundingRate >= 0 ? 'up' : 'down'}`}>
                        {(f.fundingRate * 100).toFixed(4)}%
                      </td>
                      <td className="num muted">{formatPrice(f.markPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Volume anomalies" meta="vs recent 1h mean">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Coin</th>
                  <th className="num">×Vol</th>
                  <th className="num">24h</th>
                  <th className="num">RSI</th>
                </tr>
              </thead>
              <tbody>
                {volSpike.map((m) => (
                  <tr key={m.symbol} onClick={() => setFocusSymbol(m.symbol)}>
                    <td>
                      <strong>{m.base}</strong>
                    </td>
                    <td className="num amber">{m.volumeAnomaly.toFixed(2)}×</td>
                    <td className="num">
                      <Pct value={m.change24h} />
                    </td>
                    <td className="num muted">{m.rsi.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Tape leaders" meta="24h quote volume" className="span-1">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Coin</th>
                  <th className="num">Price</th>
                  <th className="num">Δ%</th>
                  <th className="num">Volume</th>
                </tr>
              </thead>
              <tbody>
                {volLeaders.map((t, i) => (
                  <tr key={t.symbol} onClick={() => setFocusSymbol(t.symbol)}>
                    <td className="muted">{i + 1}</td>
                    <td>
                      <strong>{t.base}</strong>
                    </td>
                    <td className="num">{formatPrice(t.lastPrice)}</td>
                    <td className="num">
                      <Pct value={t.priceChangePercent} />
                    </td>
                    <td className="num muted">{formatCompact(t.quoteVolume)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Momentum extremes" meta="top / bottom 24h">
          <div className="split-2">
            <div>
              <div className="filter-label" style={{ marginBottom: 6 }}>
                Gainers
              </div>
              {moversUp.map((t) => (
                <div
                  key={t.symbol}
                  className="level-row"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setFocusSymbol(t.symbol)}
                >
                  <span>{t.base}</span>
                  <Pct value={t.priceChangePercent} />
                </div>
              ))}
            </div>
            <div>
              <div className="filter-label" style={{ marginBottom: 6 }}>
                Losers
              </div>
              {moversDown.map((t) => (
                <div
                  key={t.symbol}
                  className="level-row"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setFocusSymbol(t.symbol)}
                >
                  <span>{t.base}</span>
                  <Pct value={t.priceChangePercent} />
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </div>
      <div className="footer-note">
        <span>COMMAND · market pulse + opportunity surface</span>
        <span className="footer-note__secondary">
          Binance spot WS · futures funding · local S/R engine
        </span>
      </div>
    </div>
  )
}
