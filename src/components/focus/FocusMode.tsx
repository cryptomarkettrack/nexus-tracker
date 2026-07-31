import { useMemo, useState } from 'react'
import { formatPrice } from '../../lib/indicators'
import type { Interval } from '../../lib/types'
import { useMarketStore } from '../../stores/marketStore'
import { Panel, Pct, cn } from '../shared/utils'
import { PriceChart } from './PriceChart'
import { TradeDesk } from './TradeDesk'

const INTERVALS: Interval[] = ['5m', '15m', '1h', '4h', '1d', '1w']

const QUICK = [
  { base: 'BTC', symbol: 'BTCUSDT' },
  { base: 'ETH', symbol: 'ETHUSDT' },
  { base: 'NEXO', symbol: 'NEXOUSDT' },
  { base: 'ONDO', symbol: 'ONDOUSDT' },
] as const

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

  const ticker = tickerList.find((t) => t.symbol === focusSymbol)
  const metric = metrics.find((m) => m.symbol === focusSymbol)
  const fund = funding.get(focusSymbol)
  const base = focusSymbol.replace('USDT', '')
  const price = livePrice ?? ticker?.lastPrice

  const suggestions = useMemo(() => {
    const qq = q.trim().toUpperCase()
    const list = qq
      ? tickerList.filter((t) => t.base.includes(qq) || t.symbol.includes(qq))
      : tickerList
    return list.slice(0, 10)
  }, [q, tickerList])

  const maxBinVol = volumeProfile
    ? Math.max(...volumeProfile.bins.map((b) => b.volume), 1)
    : 1

  // Nearest higher-TF MAs as a quick read
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

  const chg = ticker?.priceChangePercent

  return (
    <div className="mode-view mode-view--focus">
      <div className="grid-focus">
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
                <span
                  className={`tag ${metric.setup}`}
                  title={metric.setupReason}
                >
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
          {/* Mobile: quick pairs sit under the chart header, above the candles */}
          <div className="focus-mobile-toolbar">
            <div className="chip-row chip-row--scroll">
              {QUICK.map((qck) => (
                <button
                  key={qck.symbol}
                  type="button"
                  className={cn('chip', focusSymbol === qck.symbol && 'active')}
                  onClick={() => setFocusSymbol(qck.symbol)}
                >
                  {qck.base}
                </button>
              ))}
            </div>
          </div>
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
          <Panel title="Navigate" meta="quick" className="focus-side focus-side--nav">
            <div className="chip-row focus-nav-quick" style={{ marginBottom: 8 }}>
              {QUICK.map((qck) => (
                <button
                  key={qck.symbol}
                  type="button"
                  className={cn('chip', focusSymbol === qck.symbol && 'active')}
                  onClick={() => setFocusSymbol(qck.symbol)}
                >
                  {qck.base}
                </button>
              ))}
            </div>
            <input
              className="search-input"
              placeholder="Search symbol…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ marginBottom: 8 }}
              enterKeyHint="search"
            />
            <div className="scroll-y focus-side-scroll">
              {suggestions.map((t) => (
                <div
                  key={t.symbol}
                  className={cn('level-row', focusSymbol === t.symbol && 'amber')}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    setFocusSymbol(t.symbol)
                    setQ('')
                  }}
                >
                  <strong style={{ fontFamily: 'var(--font-ui)' }}>{t.base}</strong>
                  <Pct value={t.priceChangePercent} />
                </div>
              ))}
            </div>
          </Panel>

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

          <Panel title="Context" meta="profile · momentum" className="focus-side focus-side--context">
            <div className="scroll-y focus-side-scroll">
              {volumeProfile && volumeProfile.bins.length ? (
                <>
                  <div className="vp-chart" style={{ height: 56, marginBottom: 8 }}>
                    {volumeProfile.bins.map((b, i) => {
                      const h = (b.volume / maxBinVol) * 100
                      const step =
                        (volumeProfile.bins[1]?.price ?? 0) - (volumeProfile.bins[0]?.price ?? 0)
                      const isPoc = Math.abs(b.price - volumeProfile.poc) < step
                      const inVa =
                        b.price >= volumeProfile.val && b.price <= volumeProfile.vah
                      return (
                        <div key={i} className="vp-bin" title={formatPrice(b.price)}>
                          <div
                            className={cn('vp-bin-bar', isPoc && 'poc', inVa && !isPoc && 'va')}
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
  )
}
