import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { AUTO_MIN_CONFIDENCE, getAutoInterval, summarizeAutoPerf } from '../../lib/autoTrader'
import { formatPrice } from '../../lib/indicators'
import { buildTradePlan, positionPnl, rMultiple } from '../../lib/tradePlan'
import type { CoinMetrics, FundingInfo, MaLevel, Trendline, WatchZone } from '../../lib/types'
import { useMarketStore } from '../../stores/marketStore'
import { cn } from '../shared/utils'

/**
 * Vertical trade rail: decision first, optional structure slot (zones),
 * then plan levels → drivers → positions → auto (progressive disclosure).
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
  const closePosition = useMarketStore((s) => s.closePosition)
  const positions = useMarketStore((s) => s.positions)
  const autoBindings = useMarketStore((s) => s.autoBindings)
  const toggleAuto = useMarketStore((s) => s.toggleAuto)
  const runAutoForFocus = useMarketStore((s) => s.runAutoForFocus)
  const autoAwaySince = useMarketStore((s) => s.autoAwaySince)
  const focusInterval = useMarketStore((s) => s.focusInterval)
  const lockedInterval = getAutoInterval(autoBindings, symbol)
  const autoOn = lockedInterval != null
  const onLockedTf = autoOn && lockedInterval === focusInterval
  const lastAutoKey = useRef('')

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

  useEffect(() => {
    if (!autoOn || !onLockedTf || !plan || price == null) return
    const openN = positions.filter((p) => p.status === 'open' && p.symbol === symbol).length
    const bucket = plan.atr > 0 ? Math.round(price / (plan.atr * 0.15)) : Math.round(price)
    const key = `${symbol}|${focusInterval}|${plan.side}|${plan.planSide}|${Math.round(plan.confidence)}|${bucket}|${openN}`
    if (key === lastAutoKey.current) return
    lastAutoKey.current = key
    runAutoForFocus(plan)
  }, [
    autoOn,
    onLockedTf,
    plan,
    price,
    symbol,
    focusInterval,
    runAutoForFocus,
    positions,
  ])

  const openForSymbol = positions.filter((p) => p.status === 'open' && p.symbol === symbol)
  const mark = price ?? 0
  const autoPerf = useMemo(
    () => summarizeAutoPerf(positions, symbol, price, autoAwaySince),
    [positions, symbol, price, autoAwaySince],
  )
  const showAutoPerf = autoOn || autoPerf.closedCount > 0 || autoPerf.openCount > 0

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
      {/* 1. Decision — glanceable, sticky within rail */}
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

      {/* Structure (zones / MAs) — ties chart colors to numbers before plan */}
      {structureSlot}

      {/* Levels — actionable numbers */}
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

      {/* 3. Why — compact, expand for full list */}
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

      {/* Open risk first if any; auto is secondary tooling */}
      {openForSymbol.length > 0 && (
        <section className="rail-section rail-section--positions">
          <div className="filter-label">Open · {base}</div>
          {openForSymbol.map((p) => {
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
                  {p.source === 'auto' && <span className="tag auto-tag">auto</span>}
                  {p.interval && <span className="tag audit-tf-tag">{p.interval}</span>}
                  <span className="grow" />
                  <span className={cn('num', pnlUsd >= 0 ? 'up' : 'down')}>
                    {pnlUsd >= 0 ? '+' : ''}
                    {pnlUsd.toFixed(2)}
                    <span className="muted" style={{ fontSize: 9 }}>
                      {' '}
                      ({pnlPct >= 0 ? '+' : ''}
                      {pnlPct.toFixed(1)}%)
                    </span>
                  </span>
                </div>
                <div className="position-meta">
                  {formatPrice(p.entry)} → stop {formatPrice(p.stop)} · T1 {formatPrice(p.target1)}
                </div>
                <div className="row-flex" style={{ marginTop: 4 }}>
                  <span className={cn('num', r >= 0 ? 'up' : 'down')}>{r.toFixed(2)}R</span>
                  {stopHit && <span className="tag weakness">stop</span>}
                  {t1Hit && !stopHit && <span className="tag breakout">T1</span>}
                  <span className="grow" />
                  <button
                    type="button"
                    className="chip"
                    onClick={() => closePosition(p.id, mark, 'manual')}
                  >
                    Close
                  </button>
                </div>
              </div>
            )
          })}
        </section>
      )}

      <section className="rail-section rail-section--trade">
        <details className="rail-details" open={autoOn || openForSymbol.length > 0}>
          <summary>
            Paper auto
            {autoOn ? (
              <span className="rail-details__badge rail-details__badge--on">
                ON · {lockedInterval}
              </span>
            ) : (
              <span className="rail-details__badge">off</span>
            )}
          </summary>

          <button
            type="button"
            className={cn('chip', 'auto-toggle', autoOn && 'active')}
            style={{ width: '100%', marginTop: 6 }}
            onClick={() => toggleAuto(symbol, focusInterval)}
            title={
              autoOn
                ? `Autopilot on ${lockedInterval} — opens/closes from that TF plan only`
                : `Enable paper autopilot locked to current TF (${focusInterval})`
            }
          >
            {autoOn
              ? `● Auto pilot ON · ${lockedInterval}`
              : `○ Auto pilot · lock ${focusInterval}`}
          </button>

          {autoOn && onLockedTf && (
            <span className="muted" style={{ fontSize: 9, display: 'block', marginTop: 4 }}>
              Opens when conf ≥ {AUTO_MIN_CONFIDENCE}% + R≥1.5 · exits stop / T1 / bias flip
            </span>
          )}
          {autoOn && !onLockedTf && (
            <span className="auto-tf-warn">
              Locked to <strong>{lockedInterval}</strong> — switch chart TF for auto opens
              (stops still managed).
            </span>
          )}

          {openForSymbol.length === 0 && (
            <div className="muted" style={{ fontSize: 10, marginTop: 8 }}>
              {autoOn
                ? onLockedTf
                  ? `No open ${base} — scanning ${lockedInterval}`
                  : `No open ${base} — auto on ${lockedInterval}`
                : `No open ${base} — paper track only`}
            </div>
          )}

          {showAutoPerf && (
            <div className="auto-perf">
              <div className="filter-label">
                Performance
                {lockedInterval ? ` · ${lockedInterval}` : ''}
              </div>
              <div className="auto-perf-grid">
                <div>
                  <span className="muted">Total</span>
                  <div className={cn('num', autoPerf.totalUsd >= 0 ? 'up' : 'down')}>
                    {autoPerf.totalUsd >= 0 ? '+' : ''}
                    {autoPerf.totalUsd.toFixed(2)}
                  </div>
                </div>
                <div>
                  <span className="muted">Realized</span>
                  <div className={cn('num', autoPerf.realizedUsd >= 0 ? 'up' : 'down')}>
                    {autoPerf.realizedUsd >= 0 ? '+' : ''}
                    {autoPerf.realizedUsd.toFixed(2)}
                  </div>
                </div>
                <div>
                  <span className="muted">Open</span>
                  <div className={cn('num', autoPerf.unrealizedUsd >= 0 ? 'up' : 'down')}>
                    {autoPerf.unrealizedUsd >= 0 ? '+' : ''}
                    {autoPerf.unrealizedUsd.toFixed(2)}
                  </div>
                </div>
                <div>
                  <span className="muted">Win rate</span>
                  <div className="num">
                    {autoPerf.closedCount
                      ? `${autoPerf.winRate.toFixed(0)}% · ${autoPerf.wins}W/${autoPerf.losses}L`
                      : '—'}
                  </div>
                </div>
              </div>
              {autoPerf.awayClosedCount > 0 && (
                <div className="auto-away">
                  Away · {autoPerf.awayClosedCount} exit
                  {autoPerf.awayClosedCount === 1 ? '' : 's'}{' '}
                  <span className={cn('num', autoPerf.awayRealizedUsd >= 0 ? 'up' : 'down')}>
                    {autoPerf.awayRealizedUsd >= 0 ? '+' : ''}
                    {autoPerf.awayRealizedUsd.toFixed(2)}
                  </span>
                </div>
              )}
            </div>
          )}
        </details>
      </section>
    </div>
  )
}
