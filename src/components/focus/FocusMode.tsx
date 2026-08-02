import { useEffect, useMemo, useRef, useState } from 'react'
import { formatPrice } from '../../lib/indicators'
import { buildTradePlan } from '../../lib/tradePlan'
import type { Interval, WatchZone } from '../../lib/types'
import { useMarketStore } from '../../stores/marketStore'
import { Panel, Pct, cn } from '../shared/utils'
import { PriceChart } from './PriceChart'
import { TradeDesk } from './TradeDesk'

const INTERVALS: Interval[] = ['5m', '15m', '1h', '4h', '1d', '1w']

/**
 * Focus layout (UX):
 *  left  = chart hero (primary attention)
 *  right = single scroll rail: decision → zones → context (collapsed) → trade tooling
 */
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
  const searchWrapRef = useRef<HTMLDivElement>(null)

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
      .slice(0, 3)
  }, [maLevels])

  /** Same plan as trade rail — exported on window for Telegram captions */
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

  const fightAbove = useMemo(
    () => watchZones.find((z) => z.side === 'above') ?? null,
    [watchZones],
  )
  const fightBelow = useMemo(
    () => watchZones.find((z) => z.side === 'below') ?? null,
    [watchZones],
  )

  useEffect(() => {
    if (!structureReady) {
      document.documentElement.removeAttribute('data-focus-ready')
      return
    }
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

  const vpHint =
    volumeProfile && price != null
      ? price > volumeProfile.vah
        ? 'Above value — continuation bias'
        : price < volumeProfile.val
          ? 'Below value — weakness watch'
          : 'Inside value — range rotation'
      : null

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
          {(fightAbove || fightBelow) && (
            <div
              className="focus-nav__fights"
              title="Next hard levels to fight (MA / structure / POC)"
            >
              {fightAbove && (
                <div className="focus-nav__fight focus-nav__fight--up" title={fightLabelTitle(fightAbove)}>
                  <span className="focus-nav__fight-dir" aria-hidden>
                    ↑
                  </span>
                  <span className="focus-nav__fight-px num">{formatPrice(fightAbove.mid)}</span>
                  <span className="focus-nav__fight-tag">{shortFightLabel(fightAbove)}</span>
                  <span className="focus-nav__fight-dist num">
                    +{Math.abs(fightAbove.distancePct).toFixed(2)}%
                  </span>
                </div>
              )}
              {fightBelow && (
                <div className="focus-nav__fight focus-nav__fight--down" title={fightLabelTitle(fightBelow)}>
                  <span className="focus-nav__fight-dir" aria-hidden>
                    ↓
                  </span>
                  <span className="focus-nav__fight-px num">{formatPrice(fightBelow.mid)}</span>
                  <span className="focus-nav__fight-tag">{shortFightLabel(fightBelow)}</span>
                  <span className="focus-nav__fight-dist num">
                    −{Math.abs(fightBelow.distancePct).toFixed(2)}%
                  </span>
                </div>
              )}
            </div>
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

      <div className="grid-focus" data-testid="focus-structure">
        {/* Primary: chart fills remaining viewport height */}
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

        {/* Secondary: single scroll rail — bias → zones → plan → tooling */}
        <aside className="focus-rail" aria-label="Structure and plan">
          <div className="focus-rail__scroll">
            <TradeDesk
              symbol={focusSymbol}
              base={base}
              price={price}
              zones={watchZones}
              maLevels={maLevels}
              metric={metric}
              funding={fund}
              trendline={trendlines[0]}
              structureSlot={
                <section className="rail-section rail-section--zones">
                  <div className="rail-section__head">
                    <span className="filter-label" style={{ margin: 0 }}>
                      Watch zones
                    </span>
                    <span className="muted" style={{ fontSize: 9 }}>
                      next reaction
                    </span>
                  </div>

                  {watchZones.length === 0 ? (
                    <div className="muted" style={{ fontSize: 11, padding: '4px 0' }}>
                      No nearby confluence — mid-range
                    </div>
                  ) : (
                    watchZones.map((z) => (
                      <div key={z.id} className={`watch-zone-card watch-zone-card--${z.side}`}>
                        <div className="row-flex" style={{ marginBottom: 4 }}>
                          <strong className="watch-zone-card__label">{z.label}</strong>
                          <span className="grow" />
                          <span className={cn('num', z.side === 'above' ? 'down' : 'up')}>
                            {z.distancePct >= 0 ? '+' : ''}
                            {z.distancePct.toFixed(2)}%
                          </span>
                        </div>
                        <div className="num watch-zone-card__px">
                          {formatPrice(z.low)}
                          {z.high - z.low > z.mid * 0.0008
                            ? ` – ${formatPrice(z.high)}`
                            : ''}
                        </div>
                        <div className="chip-row watch-zone-card__sources">
                          {z.sources.slice(0, 4).map((s) => (
                            <span key={s} className="tag" style={{ fontSize: 8 }}>
                              {s}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))
                  )}

                  {keyMas.length > 0 && (
                    <div className="rail-ma-list">
                      {keyMas.map((m) => (
                        <div key={m.id} className="level-row level-row--compact">
                          <span className="muted" style={{ minWidth: 64 }}>
                            {m.label}
                          </span>
                          <span className="num">{formatPrice(m.price)}</span>
                          <span className={cn('num', m.distancePct >= 0 ? 'down' : 'up')}>
                            {m.distancePct >= 0 ? '+' : ''}
                            {m.distancePct.toFixed(2)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {trendlines[0] && !trendlines[0].broken && (
                    <div className="insight insight--compact" style={{ marginTop: 6 }}>
                      Peak TL @ <strong>{formatPrice(trendlines[0].currentPrice)}</strong>{' '}
                      <span className="muted">
                        ({trendlines[0].distancePct >= 0 ? '+' : ''}
                        {trendlines[0].distancePct.toFixed(2)}%)
                      </span>
                    </div>
                  )}
                </section>
              }
              contextSlot={
                <section className="rail-section rail-section--context">
                  <details className="rail-details">
                    <summary>
                      Context
                      {metric && (
                        <span className="rail-details__badge">
                          RSI {metric.rsi.toFixed(0)}
                          {vpHint ? ` · ${vpHint.split('—')[0]?.trim()}` : ''}
                        </span>
                      )}
                    </summary>

                    {volumeProfile && volumeProfile.bins.length ? (
                      <>
                        <div className="vp-chart" style={{ height: 48, margin: '8px 0' }}>
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
                        <div className="level-row level-row--compact">
                          <span className="level-type vah">VAH</span>
                          <span className="num">{formatPrice(volumeProfile.vah)}</span>
                        </div>
                        <div className="level-row level-row--compact">
                          <span className="level-type poc">POC</span>
                          <span className="num amber">{formatPrice(volumeProfile.poc)}</span>
                        </div>
                        <div className="level-row level-row--compact">
                          <span className="level-type val">VAL</span>
                          <span className="num">{formatPrice(volumeProfile.val)}</span>
                        </div>
                        {vpHint && (
                          <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>
                            {vpHint}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>
                        Building profile…
                      </div>
                    )}

                    {metric && (
                      <div className="insight insight--compact" style={{ marginTop: 8 }}>
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
                  </details>
                </section>
              }
            />
          </div>
        </aside>
      </div>
    </div>
  )
}

/** Compact tag for nav: primary source, or confluence shorthand */
function shortFightLabel(z: WatchZone): string {
  if (z.sources.length >= 3) return 'Confluence'
  if (z.sources.length === 2) return z.sources.slice(0, 2).join('+')
  if (z.sources[0]) return z.sources[0]
  return z.label
}

function fightLabelTitle(z: WatchZone): string {
  const band =
    z.high - z.low > z.mid * 0.0008
      ? `${formatPrice(z.low)} – ${formatPrice(z.high)}`
      : formatPrice(z.mid)
  const src = z.sources.length ? z.sources.join(' · ') : z.label
  return `${z.side === 'above' ? 'Overhead' : 'Underfoot'} fight @ ${band} · ${src}`
}
