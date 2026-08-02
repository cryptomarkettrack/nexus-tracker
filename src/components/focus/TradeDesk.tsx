import { useMemo, type ReactNode } from 'react'
import { formatPrice } from '../../lib/indicators'
import { buildTradePlan } from '../../lib/tradePlan'
import type { CoinMetrics, FundingInfo, MaLevel, Trendline, WatchZone } from '../../lib/types'
import { useMarketStore } from '../../stores/marketStore'

/**
 * Vertical plan rail: decision → structure slot → levels → drivers → context slot.
 */
export function TradeDesk({
  symbol,
  base,
  price,
  zones,
  maLevels,
  metric,
  funding,
  trendline,
  structureSlot,
  contextSlot,
}: {
  symbol: string
  base: string
  price: number | undefined
  zones: WatchZone[]
  maLevels: MaLevel[]
  metric?: CoinMetrics
  funding?: FundingInfo
  trendline?: Trendline
  /** After bias — watch zones / MAs (primary structure) */
  structureSlot?: ReactNode
  /** After plan drivers — VP / momentum (collapsed secondary) */
  contextSlot?: ReactNode
}) {
  const focusInterval = useMarketStore((s) => s.focusInterval)

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

  if (!plan || price == null) {
    return (
      <div className="rail-section">
        <div className="empty-state" style={{ padding: 12 }}>
          Building plan…
        </div>
      </div>
    )
  }

  const primaryReasons = plan.reasons.slice(0, 2)
  const moreReasons = plan.reasons.slice(2)

  return (
    <div className="trade-rail">
      <section className="rail-section rail-section--decision">
        <div className={`bias-card bias-card--${plan.side} bias-card--rail`}>
          <div className="row-flex">
            <span className="bias-side">{plan.side.toUpperCase()}</span>
            <span className="grow" />
            <span className="bias-conf num">{plan.confidence.toFixed(0)}%</span>
          </div>
          <div className="bias-sub muted">
            {focusInterval} · MA {plan.maBias} · {plan.masBelow}↓ {plan.masAbove}↑
            {metric ? ` · RSI ${metric.rsi.toFixed(0)}` : ''}
          </div>
          <p className="bias-trigger">{plan.trigger}</p>
        </div>
      </section>

      {structureSlot}

      <section className="rail-section">
        <div className="rail-section__head">
          <span className="filter-label" style={{ margin: 0 }}>
            Plan · {plan.planSide}
          </span>
          <span className="muted" style={{ fontSize: 9 }}>
            R{plan.rr1.toFixed(1)} / R{plan.rr2.toFixed(1)}
          </span>
        </div>
        <div className="plan-grid plan-grid--rail">
          <div>
            <span className="muted">Entry</span>
            <div className="num">{formatPrice(plan.entry)}</div>
          </div>
          <div>
            <span className="muted">Stop</span>
            <div className="num down">{formatPrice(plan.stop)}</div>
          </div>
          <div>
            <span className="muted">T1</span>
            <div className="num up">{formatPrice(plan.target1)}</div>
          </div>
          <div>
            <span className="muted">T2</span>
            <div className="num up">{formatPrice(plan.target2)}</div>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 9, marginTop: 4 }}>
          Risk {plan.riskPct.toFixed(2)}% · ATR {formatPrice(plan.atr)}
        </div>
      </section>

      <section className="rail-section">
        <ul className="driver-list driver-list--rail">
          {primaryReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {(moreReasons.length > 0 || plan.invalidation) && (
          <details className="rail-details">
            <summary>More drivers · invalidation</summary>
            {moreReasons.length > 0 && (
              <ul className="driver-list driver-list--rail">
                {moreReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            <div className="insight insight--compact">
              <strong>Invalidation</strong> — {plan.invalidation}
            </div>
          </details>
        )}
      </section>

      {contextSlot}
    </div>
  )
}
