import { useEffect, useMemo, useRef, useState } from 'react'
import {
  buildAuditLog,
  formatAuditTime,
  formatHeld,
  formatOpenReason,
} from '../../lib/auditLog'
import { AUTO_MIN_CONFIDENCE, getAutoInterval, summarizeAutoPerf } from '../../lib/autoTrader'
import { formatPrice } from '../../lib/indicators'
import { buildTradePlan, describePlanOpen, positionPnl, rMultiple } from '../../lib/tradePlan'
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
  const autoBindings = useMarketStore((s) => s.autoBindings)
  const toggleAuto = useMarketStore((s) => s.toggleAuto)
  const runAutoForFocus = useMarketStore((s) => s.runAutoForFocus)
  const autoAwaySince = useMarketStore((s) => s.autoAwaySince)
  const focusInterval = useMarketStore((s) => s.focusInterval)
  const [sizeDraft, setSizeDraft] = useState(String(defaultSizeUsd))
  const [auditScope, setAuditScope] = useState<'symbol' | 'all'>('symbol')
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

  // Drive paper autopilot only when viewing the locked timeframe
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

  const auditEvents = useMemo(() => {
    const marks: Record<string, number> = {}
    if (price != null && price > 0) marks[symbol] = price
    return buildAuditLog(positions, {
      symbol: auditScope === 'symbol' ? symbol : undefined,
      markBySymbol: marks,
      limit: 60,
    })
  }, [positions, symbol, price, auditScope])

  return (
    <Panel
      title="Trade desk"
      meta={
        autoOn
          ? onLockedTf
            ? `auto · ${lockedInterval} · paper`
            : `auto locked ${lockedInterval}`
          : 'plan · PnL'
      }
      className="trade-desk"
    >
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
                <span className="muted">
                  {focusInterval} · {plan.confidence.toFixed(0)}% conf
                </span>
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
              Suggested {plan.planSide} · {focusInterval}
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

            <button
              type="button"
              className={cn('chip', 'auto-toggle', autoOn && 'active')}
              style={{ marginTop: 8, width: '100%' }}
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
                Using {lockedInterval} desk conditions · opens when conf ≥ {AUTO_MIN_CONFIDENCE}% ·
                exits stop / T1 / bias flip · paper only
              </span>
            )}
            {autoOn && !onLockedTf && (
              <span className="auto-tf-warn">
                Autopilot locked to <strong>{lockedInterval}</strong>. Viewing {focusInterval} —
                switch chart to {lockedInterval} for auto opens/flips (stops still managed).
              </span>
            )}

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
                  const openReason = describePlanOpen(plan, focusInterval, 'manual')
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
                    openReason,
                    interval: focusInterval,
                    source: 'manual',
                  })
                }}
              >
                Open {plan.planSide} @ market
              </button>
            </div>
            {plan.side === 'flat' && !autoOn && (
              <span className="muted" style={{ fontSize: 9, display: 'block', marginTop: 6 }}>
                Flat bias — opens as “if I had to”
              </span>
            )}

            {(autoOn || autoPerf.closedCount > 0 || autoPerf.openCount > 0) && (
              <div className="auto-perf">
                <div className="filter-label">
                  Auto performance · {base}
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
                    While you were away · {autoPerf.awayClosedCount} exit
                    {autoPerf.awayClosedCount === 1 ? '' : 's'}{' '}
                    <span className={cn('num', autoPerf.awayRealizedUsd >= 0 ? 'up' : 'down')}>
                      {autoPerf.awayRealizedUsd >= 0 ? '+' : ''}
                      {autoPerf.awayRealizedUsd.toFixed(2)} USD
                    </span>
                  </div>
                )}
                {autoOn && onLockedTf && autoPerf.closedCount === 0 && autoPerf.openCount === 0 && (
                  <div className="muted" style={{ fontSize: 9, marginTop: 4 }}>
                    Watching {lockedInterval} — will open when edge ≥ {AUTO_MIN_CONFIDENCE}% conf
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="trade-desk-col trade-desk-col--positions">
            <div className="filter-label">Open positions</div>
            {openForSymbol.length === 0 ? (
              <div className="muted" style={{ fontSize: 10 }}>
                {autoOn
                  ? onLockedTf
                    ? `No open ${base} — scanning ${lockedInterval}`
                    : `No open ${base} — auto on ${lockedInterval}`
                  : `No open ${base} position — paper track only`}
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
                      {p.source === 'auto' && <span className="tag auto-tag">auto</span>}
                      {p.interval && <span className="tag audit-tf-tag">{p.interval}</span>}
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
                    {(p.openReason || p.note) && (
                      <div className="position-reason">{p.openReason || p.note}</div>
                    )}
                    <div className="row-flex" style={{ marginTop: 4 }}>
                      <span className={cn('num', r >= 0 ? 'up' : 'down')}>{r.toFixed(2)}R</span>
                      {stopHit && <span className="tag weakness">stop zone</span>}
                      {t1Hit && !stopHit && <span className="tag breakout">T1 zone</span>}
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
              })
            )}

            {openForSymbol.length > 0 && (
              <div className="muted" style={{ fontSize: 9, marginTop: 6 }}>
                Full history in audit log below
              </div>
            )}
          </div>

          <div className="trade-desk-audit">
            <div className="row-flex audit-header">
              <div className="filter-label" style={{ margin: 0 }}>
                Audit log
              </div>
              <span className="grow" />
              <div className="chip-row">
                <button
                  type="button"
                  className={cn('chip', auditScope === 'symbol' && 'active')}
                  onClick={() => setAuditScope('symbol')}
                >
                  {base}
                </button>
                <button
                  type="button"
                  className={cn('chip', auditScope === 'all' && 'active')}
                  onClick={() => setAuditScope('all')}
                >
                  All
                </button>
              </div>
              <span className="muted" style={{ fontSize: 9 }}>
                {auditEvents.length} event{auditEvents.length === 1 ? '' : 's'}
              </span>
            </div>

            {auditEvents.length === 0 ? (
              <div className="muted" style={{ fontSize: 10, padding: '6px 0' }}>
                No opens or closes yet — each event logs time, timeframe, reason, and PnL.
              </div>
            ) : (
              <div className="audit-list">
                {auditEvents.map((ev) => {
                  const isOpen = ev.action === 'open'
                  const pnl = ev.pnlUsd
                  const hasPnl = pnl != null && Number.isFinite(pnl)
                  return (
                    <article
                      key={ev.id}
                      className={cn(
                        'audit-card',
                        isOpen ? 'audit-card--open' : 'audit-card--close',
                      )}
                    >
                      <div className="audit-card__top">
                        <span
                          className={cn('tag', isOpen ? 'audit-tag-open' : 'audit-tag-close')}
                        >
                          {isOpen ? 'OPEN' : 'CLOSE'}
                        </span>
                        <span
                          className={cn('tag', ev.side === 'long' ? 'strength' : 'weakness')}
                        >
                          {ev.side}
                        </span>
                        {ev.interval && (
                          <span className="tag audit-tf-tag" title="Plan timeframe">
                            {ev.interval}
                          </span>
                        )}
                        {ev.source === 'auto' ? (
                          <span className="tag auto-tag">auto</span>
                        ) : (
                          <span className="tag audit-manual-tag">manual</span>
                        )}
                        {auditScope === 'all' && (
                          <span className="tag audit-coin-tag">{ev.base}</span>
                        )}
                        <span className="grow" />
                        <time className="audit-time num" dateTime={new Date(ev.at).toISOString()}>
                          {formatAuditTime(ev.at)}
                        </time>
                      </div>

                      <div className="audit-card__meta">
                        <span>
                          <span className="muted">Price </span>
                          <span className="num">{formatPrice(ev.price)}</span>
                          {!isOpen && (
                            <span className="muted"> from {formatPrice(ev.entry)}</span>
                          )}
                        </span>
                        <span>
                          <span className="muted">Size </span>
                          <span className="num">${ev.sizeUsd.toFixed(0)}</span>
                        </span>
                        <span>
                          <span className="muted">Held </span>
                          <span className="num">
                            {isOpen ? formatHeld(Date.now() - ev.at) : formatHeld(ev.heldMs)}
                          </span>
                        </span>
                        <span>
                          <span className="muted">PnL </span>
                          {hasPnl ? (
                            <span className={cn('num', pnl! >= 0 ? 'up' : 'down')}>
                              {pnl! >= 0 ? '+' : ''}
                              {pnl!.toFixed(2)}
                              {ev.pnlPct != null && (
                                <>
                                  {' '}
                                  ({ev.pnlPct >= 0 ? '+' : ''}
                                  {ev.pnlPct.toFixed(2)}%)
                                </>
                              )}
                              {isOpen && <span className="muted"> unrealized</span>}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </span>
                      </div>

                      <p className="audit-card__reason">{formatOpenReason(ev)}</p>
                    </article>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </Panel>
  )
}
