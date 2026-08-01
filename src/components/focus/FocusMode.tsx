import { useEffect, useMemo, useRef, useState } from 'react'
import { formatPrice } from '../../lib/indicators'
import { buildTradePlan } from '../../lib/tradePlan'
import type { Interval } from '../../lib/types'
import { useMarketStore } from '../../stores/marketStore'
import { Panel, Pct, cn } from '../shared/utils'
import { PriceChart } from './PriceChart'
import { TradeDesk } from './TradeDesk'

const INTERVALS: Interval[] = ['5m', '15m', '1h', '4h', '1d', '1w']
const DESK_HEIGHT_KEY = 'nexus-trade-desk-h'
const DESK_MIN = 140
const DESK_MAX = 720
const DESK_DEFAULT = 280

function loadDeskHeight(): number {
  try {
    const n = parseInt(localStorage.getItem(DESK_HEIGHT_KEY) ?? '', 10)
    if (Number.isFinite(n) && n >= DESK_MIN && n <= DESK_MAX) return n
  } catch {
    /* ignore */
  }
  return DESK_DEFAULT
}

function saveDeskHeight(h: number) {
  try {
    localStorage.setItem(DESK_HEIGHT_KEY, String(Math.round(h)))
  } catch {
    /* ignore */
  }
}

export function FocusMode() {
  const focusSymbol = useMarketStore((s) => s.focusSymbol)
  const setFocusSymbol = useMarketStore((s) => s.setFocusSymbol)
  const focusInterval = useMarketStore((s) => s.focusInterval)
  const setFocusInterval = useMarketStore((s) => s.setFocusInterval)
  const candles = useMarketStore((s) => s.candles)
  const trendlines = useMarketStore((s) => s.trendlines)
  const watchZones = useMarketStore((s) => s.watchZones)
  const maLevels = useMarketStore((s) => s.maLevels)
  const livePrice = useMarketStore((s) => s.livePrice)
  const volumeProfile = useMarketStore((s) => s.volumeProfile)
  const tickerList = useMarketStore((s) => s.tickerList)
  const metrics = useMarketStore((s) => s.metrics)
  const funding = useMarketStore((s) => s.funding)
  const [q, setQ] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [deskH, setDeskH] = useState(loadDeskHeight)
  const searchWrapRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  const ticker = tickerList.find((t) => t.symbol === focusSymbol)
  const metric = metrics.find((m) => m.symbol === focusSymbol)
  const fund = funding.get(focusSymbol)
  const base = focusSymbol.replace('USDT', '')
  const price = livePrice ?? ticker?.lastPrice
  const chg = ticker?.priceChangePercent

  const searchHits = useMemo(() => {
    const qq = q.trim().toUpperCase()
    if (!qq) return []
    return tickerList
      .filter((t) => t.base.includes(qq) || t.symbol.includes(qq))
      .slice(0, 12)
  }, [q, tickerList])

  const maxBinVol = volumeProfile
    ? Math.max(...volumeProfile.bins.map((b) => b.volume), 1)
    : 1

  const keyMas = useMemo(() => {
    const prefer = ['1d', '1w', '4h'] as const
    return [...maLevels]
      .sort((a, b) => {
        const da = Math.abs(a.distancePct)
        const db = Math.abs(b.distancePct)
        if (Math.abs(da - db) > 0.05) return da - db
        return prefer.indexOf(a.timeframe) - prefer.indexOf(b.timeframe)
      })
      .slice(0, 4)
  }, [maLevels])

  /** Same plan as Trade desk bias column — exported on window for Telegram captions */
  const tradePlan = useMemo(() => {
    if (price == null) return null
    return buildTradePlan({
      symbol: focusSymbol,
      base,
      price,
      zones: watchZones,
      maLevels,
      metric,
      funding: fund,
      trendline: trendlines[0],
    })
  }, [focusSymbol, base, price, watchZones, maLevels, metric, fund, trendlines])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!searchWrapRef.current?.contains(e.target as Node)) {
        setSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const next = Math.min(DESK_MAX, Math.max(DESK_MIN, d.startH + (d.startY - e.clientY)))
      setDeskH(next)
    }
    const onUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      document.body.classList.remove('is-resizing-desk')
      setDeskH((h) => {
        saveDeskHeight(h)
        return h
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  const pickSymbol = (symbol: string) => {
    setFocusSymbol(symbol)
    setQ('')
    setSearchOpen(false)
  }

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && searchHits[0]) {
      e.preventDefault()
      pickSymbol(searchHits[0].symbol)
    } else if (e.key === 'Escape') {
      setSearchOpen(false)
      setQ('')
    }
  }

  const structureReady = candles.length > 0

  useEffect(() => {
    if (!structureReady) {
      document.documentElement.removeAttribute('data-focus-ready')
      return
    }
    // Brief delay so lightweight-charts paints before headless capture
    const t = window.setTimeout(() => {
      document.documentElement.setAttribute('data-focus-ready', '1')
      document.documentElement.setAttribute('data-focus-symbol', focusSymbol)
      document.documentElement.setAttribute('data-focus-interval', focusInterval)
      try {
        const snapshot = {
          symbol: focusSymbol,
          base,
          interval: focusInterval,
          price: price ?? null,
          change24h: chg ?? null,
          setup: metric?.setup ?? null,
          setupReason: metric?.setupReason ?? null,
          rsi: metric?.rsi ?? null,
          atrPct: metric?.atrPct ?? null,
          relStrengthBtc: metric?.relStrengthBtc ?? null,
          volumeAnomaly: metric?.volumeAnomaly ?? null,
          /** Trade desk bias card (LONG / SHORT / FLAT) */
          bias: tradePlan
            ? {
                side: tradePlan.side,
                confidence: tradePlan.confidence,
                maBias: tradePlan.maBias,
                masBelow: tradePlan.masBelow,
                masAbove: tradePlan.masAbove,
                reasons: tradePlan.reasons,
                trigger: tradePlan.trigger,
                invalidation: tradePlan.invalidation,
                planSide: tradePlan.planSide,
              }
            : null,
          volumeProfile: volumeProfile
            ? {
                poc: volumeProfile.poc,
                vah: volumeProfile.vah,
                val: volumeProfile.val,
              }
            : null,
          watchZones: watchZones.map((z) => ({
            label: z.label,
            side: z.side,
            low: z.low,
            high: z.high,
            mid: z.mid,
            distancePct: z.distancePct,
            sources: z.sources,
          })),
          trendline: trendlines[0]
            ? {
                type: trendlines[0].type,
                currentPrice: trendlines[0].currentPrice,
                distancePct: trendlines[0].distancePct,
                broken: trendlines[0].broken,
              }
            : null,
          capturedAt: Date.now(),
        }
        ;(window as unknown as { __NEXUS_STRUCTURE__?: typeof snapshot }).__NEXUS_STRUCTURE__ =
          snapshot
      } catch {
        /* ignore */
      }
    }, 900)
    return () => {
      window.clearTimeout(t)
      document.documentElement.removeAttribute('data-focus-ready')
    }
  }, [
    structureReady,
    focusSymbol,
    focusInterval,
    base,
    price,
    chg,
    metric,
    tradePlan,
    volumeProfile,
    watchZones,
    trendlines,
  ])

  return (
    <div
      className="mode-view mode-view--focus"
      data-focus-ready={structureReady ? '1' : '0'}
    >
      <div className="focus-nav" ref={searchWrapRef}>
        <div className="focus-nav__identity">
          <span className="focus-nav__pair">{base}/USDT</span>
          {price != null && (
            <span className={cn('focus-nav__price num', (chg ?? 0) >= 0 ? 'up' : 'down')}>
              {formatPrice(price)}
              {chg != null && (
                <span className="focus-nav__chg">
                  {chg >= 0 ? '+' : ''}
                  {chg.toFixed(2)}%
                </span>
              )}
            </span>
          )}
        </div>

        <div className="focus-nav__search">
          <input
            className="search-input focus-nav__input"
            placeholder="Search coin…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setSearchOpen(true)
            }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={onSearchKey}
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
          />
          {searchOpen && q.trim() && (
            <div className="focus-nav__dropdown" role="listbox">
              {searchHits.length === 0 ? (
                <div className="focus-nav__empty muted">No matches</div>
              ) : (
                searchHits.map((t) => (
                  <button
                    key={t.symbol}
                    type="button"
                    role="option"
                    className={cn(
                      'focus-nav__hit',
                      focusSymbol === t.symbol && 'focus-nav__hit--active',
                    )}
                    onClick={() => pickSymbol(t.symbol)}
                  >
                    <strong>{t.base}</strong>
                    <span className={cn('num', t.priceChangePercent >= 0 ? 'up' : 'down')}>
                      {t.priceChangePercent >= 0 ? '+' : ''}
                      {t.priceChangePercent.toFixed(2)}%
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="grid-focus">
        <div className="focus-main-row" data-testid="focus-structure">
          <Panel
            title={`${base} / USDT`}
            meta={
              price != null
                ? `${formatPrice(price)}${chg != null ? ` · ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : ''}`
                : `${focusInterval} · live`
            }
            className="focus-chart-panel"
            actions={
              <div className="chip-row focus-chart-actions">
                {metric ? (
                  <span className={`tag ${metric.setup}`} title={metric.setupReason}>
                    {metric.setup}
                  </span>
                ) : null}
                {INTERVALS.map((iv) => (
                  <button
                    key={iv}
                    type="button"
                    className={cn('chip', focusInterval === iv && 'active')}
                    onClick={() => setFocusInterval(iv)}
                  >
                    {iv}
                  </button>
                ))}
              </div>
            }
          >
            {candles.length ? (
              <div className="focus-chart-stage">
                <PriceChart
                  candles={candles}
                  trendlines={trendlines}
                  zones={watchZones}
                  livePrice={livePrice ?? undefined}
                  symbol={focusSymbol}
                />
              </div>
            ) : (
              <div className="empty-state">Loading klines…</div>
            )}
          </Panel>

          <aside className="focus-sidebar">
            <Panel title="Watch zones" meta="next reaction" className="focus-side focus-side--zones">
              <div className="scroll-y focus-side-scroll">
                {watchZones.length === 0 ? (
                  <div className="empty-state" style={{ padding: 16 }}>
                    No nearby confluence — wait mid-range
                  </div>
                ) : (
                  watchZones.map((z) => (
                    <div key={z.id} className={`watch-zone-card watch-zone-card--${z.side}`}>
                      <div className="row-flex" style={{ marginBottom: 6 }}>
                        <strong style={{ fontFamily: 'var(--font-ui)', fontSize: 12 }}>
                          {z.label}
                        </strong>
                        <span className="grow" />
                        <span className={z.side === 'above' ? 'down' : 'up'}>
                          {z.distancePct >= 0 ? '+' : ''}
                          {z.distancePct.toFixed(2)}%
                        </span>
                      </div>
                      <div className="num" style={{ fontSize: 14, marginBottom: 6 }}>
                        {formatPrice(z.low)}
                        {z.high - z.low > z.mid * 0.0008 ? ` – ${formatPrice(z.high)}` : ''}
                      </div>
                      <div className="chip-row" style={{ gap: 4 }}>
                        {z.sources.map((s) => (
                          <span key={s} className="tag" style={{ fontSize: 8 }}>
                            {s}
                          </span>
                        ))}
                      </div>
                      <div className="muted" style={{ marginTop: 6, fontSize: 10 }}>
                        {z.side === 'above'
                          ? 'Expect reject or breakout acceptance'
                          : 'Expect bounce or breakdown acceptance'}
                      </div>
                    </div>
                  ))
                )}

                {keyMas.length > 0 && (
                  <>
                    <div className="filter-label" style={{ marginTop: 8 }}>
                      Closest MAs
                    </div>
                    {keyMas.map((m) => (
                      <div key={m.id} className="level-row">
                        <span className="muted" style={{ minWidth: 72 }}>
                          {m.label}
                        </span>
                        <span className="num">{formatPrice(m.price)}</span>
                        <span className={m.distancePct >= 0 ? 'down' : 'up'}>
                          {m.distancePct >= 0 ? '+' : ''}
                          {m.distancePct.toFixed(2)}%
                        </span>
                      </div>
                    ))}
                  </>
                )}

                {trendlines[0] && !trendlines[0].broken && (
                  <div className="insight" style={{ marginTop: 8 }}>
                    Peak TL @ <strong>{formatPrice(trendlines[0].currentPrice)}</strong> (
                    {trendlines[0].distancePct >= 0 ? '+' : ''}
                    {trendlines[0].distancePct.toFixed(2)}%)
                  </div>
                )}
              </div>
            </Panel>

            <Panel
              title="Context"
              meta="profile · momentum"
              className="focus-side focus-side--context"
            >
              <div className="scroll-y focus-side-scroll">
                {volumeProfile && volumeProfile.bins.length ? (
                  <>
                    <div className="vp-chart" style={{ height: 56, marginBottom: 8 }}>
                      {volumeProfile.bins.map((b, i) => {
                        const h = (b.volume / maxBinVol) * 100
                        const step =
                          (volumeProfile.bins[1]?.price ?? 0) -
                          (volumeProfile.bins[0]?.price ?? 0)
                        const isPoc = Math.abs(b.price - volumeProfile.poc) < step
                        const inVa =
                          b.price >= volumeProfile.val && b.price <= volumeProfile.vah
                        return (
                          <div key={i} className="vp-bin" title={formatPrice(b.price)}>
                            <div
                              className={cn(
                                'vp-bin-bar',
                                isPoc && 'poc',
                                inVa && !isPoc && 'va',
                              )}
                              style={{ height: `${Math.max(2, h)}%` }}
                            />
                          </div>
                        )
                      })}
                    </div>
                    <div className="level-row">
                      <span className="level-type vah">VAH</span>
                      <span className="num">{formatPrice(volumeProfile.vah)}</span>
                    </div>
                    <div className="level-row">
                      <span className="level-type poc">POC</span>
                      <span className="num amber">{formatPrice(volumeProfile.poc)}</span>
                    </div>
                    <div className="level-row">
                      <span className="level-type val">VAL</span>
                      <span className="num">{formatPrice(volumeProfile.val)}</span>
                    </div>
                    {price != null && (
                      <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>
                        {price > volumeProfile.vah
                          ? 'Price above value — trend continuation bias'
                          : price < volumeProfile.val
                            ? 'Price below value — weakness / mean-revert up watch'
                            : 'Price inside value — range rotation likely'}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="empty-state">Building profile…</div>
                )}
                {metric && (
                  <div className="insight" style={{ marginTop: 8 }}>
                    RSI <strong>{metric.rsi.toFixed(0)}</strong> · vol{' '}
                    <strong>{metric.volumeAnomaly.toFixed(2)}×</strong> · vs BTC{' '}
                    <strong>
                      <Pct value={metric.relStrengthBtc} />
                    </strong>
                    {metric.atrPct > 0 && (
                      <>
                        {' '}
                        · ATR <strong>{metric.atrPct.toFixed(2)}%</strong>
                      </>
                    )}
                  </div>
                )}
              </div>
            </Panel>
          </aside>
        </div>

        <div
          className="trade-desk-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize trade desk"
          aria-valuemin={DESK_MIN}
          aria-valuemax={DESK_MAX}
          aria-valuenow={Math.round(deskH)}
          onPointerDown={(e) => {
            e.preventDefault()
            dragRef.current = { startY: e.clientY, startH: deskH }
            document.body.classList.add('is-resizing-desk')
            ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
          }}
          onDoubleClick={() => {
            setDeskH(DESK_DEFAULT)
            saveDeskHeight(DESK_DEFAULT)
          }}
          title="Drag to resize trade desk · double-click to reset"
        >
          <span className="trade-desk-resizer__grip" />
        </div>

        <div className="trade-desk-shell" style={{ height: deskH }}>
          <TradeDesk
            symbol={focusSymbol}
            base={base}
            price={price}
            zones={watchZones}
            maLevels={maLevels}
            metric={metric}
            funding={fund}
            trendline={trendlines[0]}
          />
        </div>
      </div>
    </div>
  )
}
