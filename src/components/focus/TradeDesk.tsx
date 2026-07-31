import { useMemo, useState } from 'react'
import { formatPrice } from '../../lib/indicators'
import { buildTradePlan, positionPnl, rMultiple } from '../../lib/tradePlan'
import type { CoinMetrics, FundingInfo, MaLevel, Trendline, WatchZone } from '../../lib/types'
import { useMarketStore } from '../../stores/marketStore'
import { Panel, cn } from '../shared/utils'

export function TradeDesk({
  symbol,
  base,
  price,
  zones,
  maLevels,
  metric,
  funding,
  trendline,
}: {
  symbol: string
  base: string
  price: number | undefined
  zones: WatchZone[]
  maLevels: MaLevel[]
  metric?: CoinMetrics
  funding?: FundingInfo
  trendline?: Trendline
}) {
  const openPosition = useMarketStore((s) => s.openPosition)
  const closePosition = useMarketStore((s) => s.closePosition)
  const positions = useMarketStore((s) => s.positions)
  const defaultSizeUsd = useMarketStore((s) => s.defaultSizeUsd)
  const setDefaultSizeUsd = useMarketStore((s) => s.setDefaultSizeUsd)
  const [sizeDraft, setSizeDraft] = useState(String(defaultSizeUsd))

  const plan = useMemo(() => {
    if (price == null) return null
    return buildTradePlan({
      symbol,
      base,
      price,
      zones,
      maLevels,
      metric,
      funding,
      trendline,
    })
  }, [symbol, base, price, zones, maLevels, metric, funding, trendline])

  const openForSymbol = positions.filter((p) => p.status === 'open' && p.symbol === symbol)
  const recentClosed = positions
    .filter((p) => p.status === 'closed' && p.symbol === symbol)
    .slice(0, 3)

  const mark = price ?? 0

  return (
    <Panel title="Trade desk" meta="plan · PnL" className="trade-desk">
      {!plan || price == null ? (
        <div className="empty-state" style={{ padding: 12 }}>
          Building plan…
        </div>
      ) : (
        <div className="trade-desk-layout">
          <div className="trade-desk-col trade-desk-col--bias">
            <div className={`bias-card bias-card--${plan.side}`}>
              <div className="row-flex">
                <span className="bias-side">{plan.side.toUpperCase()}</span>
                <span className="grow" />
                <span className="muted">{plan.confidence.toFixed(0)}% conf</span>
              </div>
              <div className="muted" style={{ marginTop: 6, fontSize: 10 }}>
                MA stack {plan.maBias} · {plan.masBelow} below / {plan.masAbove} above · RSI{' '}
                {metric ? metric.rsi.toFixed(0) : '—'}
              </div>
            </div>
            <ul className="driver-list">
              {plan.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>

          <div className="trade-desk-col trade-desk-col--plan">
            <div className="insight">
              <strong>Trigger</strong> — {plan.trigger}
              <br />
              <strong>Invalidation</strong> — {plan.invalidation}
            </div>
            <div className="filter-label" style={{ marginTop: 8 }}>
              Suggested {plan.planSide}
            </div>
            <div className="plan-grid">
              <div>
                <span className="muted">Entry</span>
                <div className="num">{formatPrice(plan.entry)}</div>
              </div>
              <div>
                <span className="muted">Stop</span>
                <div className="num down">{formatPrice(plan.stop)}</div>
              </div>
              <div>
                <span className="muted">T1 · R{plan.rr1.toFixed(1)}</span>
                <div className="num up">{formatPrice(plan.target1)}</div>
              </div>
              <div>
                <span className="muted">T2 · R{plan.rr2.toFixed(1)}</span>
                <div className="num up">{formatPrice(plan.target2)}</div>
              </div>
            </div>
            <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
              Risk {plan.riskPct.toFixed(2)}% · ATR {formatPrice(plan.atr)}
            </div>
          </div>

          <div className="trade-desk-col trade-desk-col--action">
            <label className="size-field">
              <span className="muted">Size USD</span>
              <input
                className="search-input"
                value={sizeDraft}
                onChange={(e) => setSizeDraft(e.target.value)}
                onBlur={() => {
                  const n = parseFloat(sizeDraft)
                  if (Number.isFinite(n)) setDefaultSizeUsd(n)
                }}
              />
            </label>
            <div className="chip-row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className={cn(
                  'chip',
                  'active',
                  plan.planSide === 'long' ? 'chip-long' : 'chip-short',
                )}
                disabled={plan.side === 'flat' && plan.confidence < 40}
                onClick={() => {
                  const size = parseFloat(sizeDraft) || defaultSizeUsd
                  openPosition({
                    symbol,
                    base,
                    side: plan.planSide,
                    entry: price,
                    stop: plan.stop,
                    target1: plan.target1,
                    target2: plan.target2,
                    sizeUsd: size,
                    note: plan.reasons[0] ?? plan.trigger,
                  })
                }}
              >
                Open {plan.planSide} @ market
              </button>
            </div>
            {plan.side === 'flat' && (
              <span className="muted" style={{ fontSize: 9, display: 'block', marginTop: 6 }}>
                Flat bias — opens as “if I had to”
              </span>
            )}
          </div>

          <div className="trade-desk-col trade-desk-col--positions">
            <div className="filter-label">Open positions</div>
            {openForSymbol.length === 0 ? (
              <div className="muted" style={{ fontSize: 10 }}>
                No open {base} position — paper track only
              </div>
            ) : (
              openForSymbol.map((p) => {
                const { pnlUsd, pnlPct } = positionPnl(p.side, p.entry, mark, p.sizeUsd)
                const r = rMultiple(p.side, p.entry, p.stop, mark)
                const stopHit = p.side === 'long' ? mark <= p.stop : mark >= p.stop
                const t1Hit = p.side === 'long' ? mark >= p.target1 : mark <= p.target1
                return (
                  <div key={p.id} className="position-card">
                    <div className="row-flex">
                      <span className={cn('tag', p.side === 'long' ? 'strength' : 'weakness')}>
                        {p.side}
                      </span>
                      <span className="muted" style={{ fontSize: 10 }}>
                        ${p.sizeUsd.toFixed(0)}
                      </span>
                      <span className="grow" />
                      <span className={cn('num', pnlUsd >= 0 ? 'up' : 'down')}>
                        {pnlUsd >= 0 ? '+' : ''}
                        {pnlUsd.toFixed(2)} ({pnlPct >= 0 ? '+' : ''}
                        {pnlPct.toFixed(2)}%)
                      </span>
                    </div>
                    <div className="position-meta">
                      entry {formatPrice(p.entry)} · stop {formatPrice(p.stop)} · T1{' '}
                      {formatPrice(p.target1)}
                    </div>
                    <div className="row-flex" style={{ marginTop: 4 }}>
                      <span className={cn('num', r >= 0 ? 'up' : 'down')}>{r.toFixed(2)}R</span>
                      {stopHit && <span className="tag weakness">stop zone</span>}
                      {t1Hit && !stopHit && <span className="tag breakout">T1 zone</span>}
                      <span className="grow" />
                      <button
                        type="button"
                        className="chip"
                        onClick={() => closePosition(p.id, mark)}
                      >
                        Close
                      </button>
                    </div>
                  </div>
                )
              })
            )}

            {recentClosed.length > 0 && (
              <>
                <div className="filter-label" style={{ marginTop: 8 }}>
                  Closed
                </div>
                {recentClosed.map((p) => (
                  <div key={p.id} className="level-row">
                    <span className="muted">{p.side}</span>
                    <span
                      className={cn(
                        'num',
                        (p.realizedPnlUsd ?? 0) >= 0 ? 'up' : 'down',
                      )}
                    >
                      {(p.realizedPnlUsd ?? 0) >= 0 ? '+' : ''}
                      {(p.realizedPnlUsd ?? 0).toFixed(2)}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </Panel>
  )
}
