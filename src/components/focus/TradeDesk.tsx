import { useEffect, useMemo, useRef, useState } from 'react'
import {
  buildAuditLog,
  closeReasonLabel,
  formatAuditTime,
  formatHeld,
} from '../../lib/auditLog'
import { AUTO_MIN_CONFIDENCE, summarizeAutoPerf } from '../../lib/autoTrader'
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
  const autoSymbols = useMarketStore((s) => s.autoSymbols)
  const toggleAuto = useMarketStore((s) => s.toggleAuto)
  const runAutoForFocus = useMarketStore((s) => s.runAutoForFocus)
  const autoAwaySince = useMarketStore((s) => s.autoAwaySince)
  const [sizeDraft, setSizeDraft] = useState(String(defaultSizeUsd))
  const [auditScope, setAuditScope] = useState<'symbol' | 'all'>('symbol')
  const autoOn = autoSymbols.includes(symbol)
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

  // Drive paper autopilot on bias / position changes (exits also run via store tick)
  useEffect(() => {
    if (!autoOn || !plan || price == null) return
    const openN = positions.filter((p) => p.status === 'open' && p.symbol === symbol).length
    // Coarse price bucket so live ticks don't thrash; re-run on side/conf/open changes
    const bucket = plan.atr > 0 ? Math.round(price / (plan.atr * 0.15)) : Math.round(price)
    const key = `${symbol}|${plan.side}|${plan.planSide}|${Math.round(plan.confidence)}|${bucket}|${openN}`
    if (key === lastAutoKey.current) return
    lastAutoKey.current = key
    runAutoForFocus(plan)
  }, [autoOn, plan, price, symbol, runAutoForFocus, positions])

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
      meta={autoOn ? 'auto pilot · paper' : 'plan · PnL'}
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

            <button
              type="button"
              className={cn('chip', 'auto-toggle', autoOn && 'active')}
              style={{ marginTop: 8, width: '100%' }}
              onClick={() => toggleAuto(symbol)}
              title={
                autoOn
                  ? 'Autopilot on — opens/closes paper positions from desk bias, stop & T1'
                  : 'Enable paper autopilot for this symbol'
              }
            >
              {autoOn ? '● Auto pilot ON' : '○ Auto pilot'}
            </button>
            {autoOn && (
              <span className="muted" style={{ fontSize: 9, display: 'block', marginTop: 4 }}>
                Opens {plan.planSide} when conf ≥ {AUTO_MIN_CONFIDENCE}% · auto-exits stop / T1 /
                bias flip · paper only
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
                <div className="filter-label">Auto performance · {base}</div>
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
                {autoOn && autoPerf.closedCount === 0 && autoPerf.openCount === 0 && (
                  <div className="muted" style={{ fontSize: 9, marginTop: 4 }}>
                    Watching market — will open when edge ≥ {AUTO_MIN_CONFIDENCE}% conf
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
                  ? `No open ${base} — autopilot scanning`
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
                No opens or closes yet — manual or auto trades will appear here with time, price,
                and PnL.
              </div>
            ) : (
              <div className="audit-table-wrap">
                <table className="audit-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Event</th>
                      <th>Side</th>
                      {auditScope === 'all' && <th>Coin</th>}
                      <th>Price</th>
                      <th>Size</th>
                      <th>PnL</th>
                      <th>Held</th>
                      <th>Via</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditEvents.map((ev) => {
                      const isOpen = ev.action === 'open'
                      const pnl = ev.pnlUsd
                      const hasPnl = pnl != null && Number.isFinite(pnl)
                      return (
                        <tr
                          key={ev.id}
                          className={cn(
                            'audit-row',
                            isOpen ? 'audit-row--open' : 'audit-row--close',
                          )}
                        >
                          <td className="audit-time num">{formatAuditTime(ev.at)}</td>
                          <td>
                            <span
                              className={cn(
                                'tag',
                                isOpen ? 'audit-tag-open' : 'audit-tag-close',
                              )}
                            >
                              {isOpen ? 'OPEN' : 'CLOSE'}
                            </span>
                          </td>
                          <td>
                            <span
                              className={cn(
                                'tag',
                                ev.side === 'long' ? 'strength' : 'weakness',
                              )}
                            >
                              {ev.side}
                            </span>
                          </td>
                          {auditScope === 'all' && (
                            <td className="muted">{ev.base}</td>
                          )}
                          <td className="num">
                            {formatPrice(ev.price)}
                            {!isOpen && (
                              <span className="muted" style={{ fontSize: 9, display: 'block' }}>
                                from {formatPrice(ev.entry)}
                              </span>
                            )}
                          </td>
                          <td className="num muted">${ev.sizeUsd.toFixed(0)}</td>
                          <td className="num">
                            {hasPnl ? (
                              <span className={cn(pnl! >= 0 ? 'up' : 'down')}>
                                {pnl! >= 0 ? '+' : ''}
                                {pnl!.toFixed(2)}
                                {ev.pnlPct != null && (
                                  <span className="muted" style={{ fontSize: 9, marginLeft: 4 }}>
                                    ({ev.pnlPct >= 0 ? '+' : ''}
                                    {ev.pnlPct.toFixed(2)}%)
                                  </span>
                                )}
                                {isOpen && (
                                  <span className="muted" style={{ fontSize: 9, display: 'block' }}>
                                    unrealized
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td className="num muted">
                            {isOpen
                              ? formatHeld(Date.now() - ev.at)
                              : formatHeld(ev.heldMs)}
                          </td>
                          <td>
                            {ev.source === 'auto' ? (
                              <span className="tag auto-tag">auto</span>
                            ) : (
                              <span className="muted" style={{ fontSize: 10 }}>
                                manual
                              </span>
                            )}
                          </td>
                          <td className="audit-detail muted">
                            {isOpen
                              ? ev.note || '—'
                              : `${closeReasonLabel(ev.closeReason)}${ev.note ? ` · ${ev.note}` : ''}`}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Panel>
  )
}
