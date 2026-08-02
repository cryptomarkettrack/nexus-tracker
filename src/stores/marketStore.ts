import { create } from 'zustand'
import {
  BinanceSocket,
  allTickerStream,
  fetchAllTickers,
  fetchFundingRates,
  fetchKlines,
  KLINES_MAX_LIMIT,
  klineStream,
  parseWsTicker,
} from '../lib/binance'
import {
  buildCoinMetrics,
  detectRegime,
  findSwingLevels,
  marketBreadth,
  nearestWatchLevels,
  profileLevels,
  volumeProfile,
} from '../lib/indicators'
import { SECTOR_ORDER, SECTORS } from '../lib/sectors'
import { computeNearbyMaLevels, MA_KLINE_LIMIT, MA_TIMEFRAMES } from '../lib/ma'

/** Focus chart history — full Binance page (1000 bars). On 1d ≈ ~2.7y. */
const FOCUS_KLINE_LIMIT = KLINES_MAX_LIMIT
import { detectTrendlines, nearestChartLevels } from '../lib/trendlines'
import { readBootParams } from '../lib/bootParams'
import { buildWatchZones, collectZoneSources } from '../lib/zones'
import type {
  Candle,
  CoinMetrics,
  FundingInfo,
  Interval,
  Level,
  MaLevel,
  MaTimeframe,
  MarketBreadth,
  MarketRegime,
  Mode,
  SectorBucket,
  Ticker24h,
  Trendline,
  VolumeProfile,
  WatchLevel,
  WatchZone,
} from '../lib/types'

const boot = readBootParams()

const socket = new BinanceSocket()

/** SCAN timeframe options (structure-friendly). */
export const SCANNER_INTERVALS: Interval[] = ['15m', '1h', '4h', '1d']

/** How many bars to pull per TF for RSI / range / vol. */
function scannerBarLimit(interval: Interval): number {
  switch (interval) {
    case '15m':
      return 96 // ~1 day
    case '1h':
      return 72 // 3 days
    case '4h':
      return 60 // 10 days
    case '1d':
      return 60 // ~2 months
    default:
      return 72
  }
}

/** Universe size for a scan run (top liquid USDT pairs by quote vol). */
const SCANNER_UNIVERSE = 200
/** Concurrent kline fetches per batch (keeps under Binance REST weight). */
const SCANNER_FETCH_CONCURRENCY = 6

export type ScannerStatus = 'idle' | 'scanning' | 'ready' | 'error'

interface MarketState {
  mode: Mode
  setMode: (m: Mode) => void
  connection: 'idle' | 'connecting' | 'live' | 'disconnected' | 'error'
  error: string | null
  tickers: Map<string, Ticker24h>
  tickerList: Ticker24h[]
  funding: Map<string, FundingInfo>
  metrics: CoinMetrics[]
  breadth: MarketBreadth | null
  regime: MarketRegime | null
  sectors: SectorBucket[]
  focusSymbol: string
  setFocusSymbol: (s: string, opts?: { interval?: Interval }) => void
  focusInterval: Interval
  setFocusInterval: (i: Interval) => void
  candles: Candle[]
  levels: Level[]
  trendlines: Trendline[]
  maLevels: MaLevel[]
  watchZones: WatchZone[]
  livePrice: number | null
  volumeProfile: VolumeProfile | null
  watchLevels: WatchLevel[]
  /** SCAN tab: selected TF + results of last run */
  scannerInterval: Interval
  setScannerInterval: (i: Interval) => void
  scannerMetrics: CoinMetrics[]
  scannerWatchLevels: WatchLevel[]
  scannerStatus: ScannerStatus
  scannerProgress: { done: number; total: number }
  scannerError: string | null
  scannerScannedAt: number
  /** Fetch klines on scannerInterval and rebuild conviction metrics */
  runScanner: (interval?: Interval) => Promise<void>
  lastRefresh: number
  bootstrap: () => Promise<void>
  refreshFocus: () => Promise<void>
  hydrateMetrics: () => void
}

let unsubTicker: (() => void) | null = null
let unsubKline: (() => void) | null = null
let metricsTimer: ReturnType<typeof setInterval> | null = null
let fundingTimer: ReturnType<typeof setInterval> | null = null
let candleCache = new Map<string, Candle[]>()
/** Keyed `${interval}|${symbol}` — SCAN TF candles (separate from 1h cmd cache). */
let scannerCandleCache = new Map<string, Candle[]>()
let bootstrapped = false
let bootstrapPromise: Promise<void> | null = null
let focusRequestId = 0
let scannerRequestId = 0

async function enrichCandles(symbols: string[]) {
  // fetch a batch of 1h candles for RSI/ATR/volume anomaly (rate-limit friendly)
  const need = symbols.filter((s) => !candleCache.has(s)).slice(0, 40)
  for (const s of need) {
    try {
      const k = await fetchKlines(s, '1h', 48)
      candleCache.set(s, k)
      await sleep(80)
    } catch {
      /* skip */
    }
  }
}

function scannerCacheKey(interval: Interval, symbol: string) {
  return `${interval}|${symbol}`
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function computeSectors(list: Ticker24h[]): SectorBucket[] {
  return SECTOR_ORDER.map((id) => {
    const symbols = SECTORS[id] ?? []
    const members = list.filter((t) => symbols.includes(t.base))
    if (!members.length) {
      return {
        id,
        name: id,
        symbols: [],
        avgChange: 0,
        totalVolume: 0,
        leaders: [],
        laggards: [],
      }
    }
    const avgChange = members.reduce((a, t) => a + t.priceChangePercent, 0) / members.length
    const totalVolume = members.reduce((a, t) => a + t.quoteVolume, 0)
    const sorted = [...members].sort((a, b) => b.priceChangePercent - a.priceChangePercent)
    return {
      id,
      name: id,
      symbols: members.map((m) => m.base),
      avgChange,
      totalVolume,
      leaders: sorted.slice(0, 3).map((m) => m.base),
      laggards: sorted.slice(-3).reverse().map((m) => m.base),
    }
  }).filter((s) => s.symbols.length > 0)
}

export const useMarketStore = create<MarketState>((set, get) => ({
  mode: boot.mode ?? 'focus',
  setMode: (m) => {
    set({ mode: m })
    if (m === 'focus') void get().refreshFocus()
    // First visit to SCAN: auto-run on default TF so the board isn't empty
    if (m === 'scanner') {
      const { scannerStatus, scannerMetrics, runScanner } = get()
      if (scannerStatus === 'idle' && scannerMetrics.length === 0) {
        void runScanner()
      }
    }
  },
  connection: 'idle',
  error: null,
  tickers: new Map(),
  tickerList: [],
  funding: new Map(),
  metrics: [],
  breadth: null,
  regime: null,
  sectors: [],
  focusSymbol: boot.symbol ?? 'BTCUSDT',
  setFocusSymbol: (s, opts) => {
    if (opts?.interval) {
      set({ focusSymbol: s, focusInterval: opts.interval, mode: 'focus' })
    } else {
      set({ focusSymbol: s, mode: 'focus' })
    }
    void get().refreshFocus()
  },
  focusInterval: boot.interval ?? '1d',
  setFocusInterval: (i) => {
    set({ focusInterval: i })
    void get().refreshFocus()
  },
  candles: [],
  levels: [],
  trendlines: [],
  maLevels: [],
  watchZones: [],
  livePrice: null,
  volumeProfile: null,
  watchLevels: [],

  scannerInterval: '4h',
  setScannerInterval: (i) => set({ scannerInterval: i }),
  scannerMetrics: [],
  scannerWatchLevels: [],
  scannerStatus: 'idle',
  scannerProgress: { done: 0, total: 0 },
  scannerError: null,
  scannerScannedAt: 0,

  runScanner: async (intervalArg) => {
    const interval = intervalArg ?? get().scannerInterval
    const req = ++scannerRequestId
    const { tickerList } = get()
    if (!tickerList.length) {
      set({ scannerStatus: 'error', scannerError: 'No tickers yet — wait for live book' })
      return
    }

    const limit = scannerBarLimit(interval)
    const universe = tickerList.slice(0, SCANNER_UNIVERSE)
    // Always include BTC for relative strength baseline
    if (!universe.some((t) => t.symbol === 'BTCUSDT')) {
      const btc = tickerList.find((t) => t.symbol === 'BTCUSDT')
      if (btc) universe.unshift(btc)
    }

    set({
      scannerInterval: interval,
      scannerStatus: 'scanning',
      scannerError: null,
      scannerProgress: { done: 0, total: universe.length },
    })

    const avgVol =
      tickerList.slice(0, 100).reduce((a, t) => a + t.quoteVolume, 0) /
      Math.min(100, tickerList.length)

    try {
      // BTC first so RS is ready
      let btcCandles: Candle[] = []
      try {
        btcCandles = await fetchKlines('BTCUSDT', interval, limit)
        scannerCandleCache.set(scannerCacheKey(interval, 'BTCUSDT'), btcCandles)
      } catch {
        /* RS falls back to 0 */
      }
      if (req !== scannerRequestId) return

      const btcWin = btcCandles.length >= 10 ? btcCandles : null
      const btcOpen = btcWin?.[0]?.open ?? 0
      const btcClose = btcWin?.[btcWin.length - 1]?.close ?? 0
      const btcChange =
        btcOpen > 0 && btcClose > 0 ? ((btcClose - btcOpen) / btcOpen) * 100 : 0

      let done = 0
      // Batch concurrent fetches so 200 pairs finish in ~30–40s instead of minutes
      for (let i = 0; i < universe.length; i += SCANNER_FETCH_CONCURRENCY) {
        if (req !== scannerRequestId) return
        const batch = universe.slice(i, i + SCANNER_FETCH_CONCURRENCY)
        await Promise.all(
          batch.map(async (t) => {
            const key = scannerCacheKey(interval, t.symbol)
            try {
              if (t.symbol === 'BTCUSDT' && btcCandles.length) {
                scannerCandleCache.set(key, btcCandles)
              } else {
                const k = await fetchKlines(t.symbol, interval, limit)
                scannerCandleCache.set(key, k)
              }
            } catch {
              scannerCandleCache.delete(key)
            }
          }),
        )
        done = Math.min(universe.length, i + batch.length)
        set({ scannerProgress: { done, total: universe.length } })
        await sleep(40)
      }
      if (req !== scannerRequestId) return

      const metrics: CoinMetrics[] = []
      const watch: WatchLevel[] = []
      for (const t of universe) {
        const candles = scannerCandleCache.get(scannerCacheKey(interval, t.symbol))
        if (!candles?.length) continue
        metrics.push(
          buildCoinMetrics(t, candles, btcChange, avgVol, { scanInterval: interval }),
        )
        // Structure levels on the same TF window
        if (watch.length < 50) {
          const swings = findSwingLevels(candles, 2, 6)
          const vp = volumeProfile(candles, 32)
          const merged = [...swings, ...profileLevels(vp)]
          watch.push(...nearestWatchLevels(t.symbol, t.base, t.lastPrice, merged, 2))
        }
      }
      watch.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))

      set({
        scannerMetrics: metrics.sort((a, b) => b.setupScore - a.setupScore),
        scannerWatchLevels: watch.slice(0, 40),
        scannerStatus: 'ready',
        scannerProgress: { done: universe.length, total: universe.length },
        scannerScannedAt: Date.now(),
        scannerError: null,
      })
    } catch (e) {
      if (req !== scannerRequestId) return
      set({
        scannerStatus: 'error',
        scannerError: e instanceof Error ? e.message : 'Scan failed',
      })
    }
  },

  lastRefresh: 0,

  hydrateMetrics: () => {
    const { tickerList, funding } = get()
    if (!tickerList.length) return
    const btc = tickerList.find((t) => t.symbol === 'BTCUSDT')
    const eth = tickerList.find((t) => t.symbol === 'ETHUSDT')
    const btcChange = btc?.priceChangePercent ?? 0
    const avgVol =
      tickerList.slice(0, 100).reduce((a, t) => a + t.quoteVolume, 0) /
      Math.min(100, tickerList.length)

    // top by volume for metrics enrichment
    const top = tickerList.slice(0, 80)
    const metrics = top.map((t) =>
      buildCoinMetrics(t, candleCache.get(t.symbol), btcChange, avgVol),
    )

    const breadth = marketBreadth(tickerList)
    const fundRates = [...funding.values()].map((f) => f.fundingRate)
    const fundingAvg = fundRates.length
      ? fundRates.reduce((a, b) => a + b, 0) / fundRates.length
      : 0
    const regime = detectRegime(btc, eth, breadth, fundingAvg)
    const sectors = computeSectors(tickerList)

    // cross-market watch levels from cached candles
    const watch: WatchLevel[] = []
    for (const t of top.slice(0, 25)) {
      const c = candleCache.get(t.symbol)
      if (!c?.length) continue
      const swings = findSwingLevels(c, 2, 6)
      const vp = volumeProfile(c, 32)
      const merged = [...swings, ...profileLevels(vp)]
      watch.push(...nearestWatchLevels(t.symbol, t.base, t.lastPrice, merged, 2))
    }
    watch.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))

    set({
      metrics: metrics.sort((a, b) => b.setupScore - a.setupScore),
      breadth,
      regime,
      sectors,
      watchLevels: watch.slice(0, 40),
      lastRefresh: Date.now(),
    })
  },

  bootstrap: async () => {
    if (bootstrapPromise) return bootstrapPromise
    bootstrapPromise = (async () => {
      set({ connection: 'connecting', error: null })
      socket.onStatus((s) => set({ connection: s }))

      try {
        const [tickers, funding] = await Promise.all([
          fetchAllTickers(),
          fetchFundingRates().catch(() => new Map<string, FundingInfo>()),
        ])
        const map = new Map(tickers.map((t) => [t.symbol, t]))
        set({ tickerList: tickers, tickers: map, funding, connection: 'live' })

        // background candle enrichment for top symbols
        void enrichCandles(tickers.slice(0, 50).map((t) => t.symbol)).then(() => {
          get().hydrateMetrics()
        })

        get().hydrateMetrics()
        void get().refreshFocus()

        if (!bootstrapped) {
          if (unsubTicker) unsubTicker()
          unsubTicker = socket.subscribe(allTickerStream, (data) => {
            if (!Array.isArray(data)) return
            const { tickers: prev } = get()
            const next = new Map(prev)
            let changed = false
            for (const raw of data as Record<string, string | number>[]) {
              const t = parseWsTicker(raw)
              if (!t) continue
              // only track already known liquid pairs + large movers
              if (!next.has(t.symbol) && t.quoteVolume < 200_000) continue
              next.set(t.symbol, t)
              changed = true
            }
            if (!changed) return
            const list = [...next.values()].sort((a, b) => b.quoteVolume - a.quoteVolume)
            set({ tickers: next, tickerList: list })
          })

          if (metricsTimer) clearInterval(metricsTimer)
          metricsTimer = setInterval(() => get().hydrateMetrics(), 12_000)

          if (fundingTimer) clearInterval(fundingTimer)
          fundingTimer = setInterval(async () => {
            try {
              const f = await fetchFundingRates()
              set({ funding: f })
            } catch {
              /* ignore */
            }
          }, 60_000)

          // keep enriching more symbols over time
          void (async () => {
            const list = get().tickerList
            for (let i = 50; i < Math.min(120, list.length); i += 10) {
              await enrichCandles(list.slice(i, i + 10).map((t) => t.symbol))
              get().hydrateMetrics()
              await sleep(2000)
            }
          })()
          bootstrapped = true
        }
      } catch (e) {
        bootstrapPromise = null
        set({
          connection: 'error',
          error: e instanceof Error ? e.message : 'Failed to connect',
        })
      }
    })()
    return bootstrapPromise
  },

  refreshFocus: async () => {
    const { focusSymbol, focusInterval } = get()
    const req = ++focusRequestId

    // Drop stale series immediately so the chart doesn't paint wrong history,
    // and so the WS handler never merges into a previous TF/symbol set.
    if (unsubKline) {
      unsubKline()
      unsubKline = null
    }
    set({
      candles: [],
      trendlines: [],
      levels: [],
      maLevels: [],
      watchZones: [],
      volumeProfile: null,
      livePrice: get().tickers.get(focusSymbol)?.lastPrice ?? null,
    })

    try {
      const [candles, ...maTfCandles] = await Promise.all([
        fetchKlines(focusSymbol, focusInterval, FOCUS_KLINE_LIMIT),
        ...MA_TIMEFRAMES.map((tf) =>
          fetchKlines(focusSymbol, tf, MA_KLINE_LIMIT).catch(() => [] as Candle[]),
        ),
      ])
      if (req !== focusRequestId) return
      if (!candles.length) {
        set({ error: `No klines for ${focusSymbol} ${focusInterval}` })
        return
      }

      candleCache.set(focusSymbol, candles)

      const byTf: Partial<Record<MaTimeframe, Candle[]>> = {}
      MA_TIMEFRAMES.forEach((tf, i) => {
        const series = maTfCandles[i]
        if (series?.length) byTf[tf] = series
      })

      const swings = findSwingLevels(candles, 3, 10)
      const vp = volumeProfile(candles, 40)
      const allLevels = [...swings, ...profileLevels(vp)].sort((a, b) => a.price - b.price)
      const price =
        candles[candles.length - 1]?.close ??
        get().tickers.get(focusSymbol)?.lastPrice ??
        0
      const levels = nearestChartLevels(allLevels, price, 2)
      const trendlines = detectTrendlines(candles, {
        lookback: 3,
        maxLines: 1,
        touchTolPct: 0.006,
        minSpan: 5,
      })
      // Wider MA net for clustering into zones (chart only shows zones)
      const maLevels = computeNearbyMaLevels(byTf, price, 4.5, 18)
      const watchZones = buildWatchZones(
        price,
        collectZoneSources(price, maLevels, levels, trendlines),
        { clusterPct: 0.6, maxDistPct: 4.5 },
      )
      const focusWatch = nearestWatchLevels(
        focusSymbol,
        focusSymbol.replace('USDT', ''),
        price,
        allLevels,
        4,
      )
      set({
        candles,
        volumeProfile: vp,
        levels,
        trendlines,
        maLevels,
        watchZones,
        livePrice: price,
        watchLevels: (() => {
          const others = get().watchLevels.filter((w) => w.symbol !== focusSymbol)
          return [...focusWatch, ...others].slice(0, 50)
        })(),
      })

      // Live kline stream for dynamic last candle + price
      const stream = klineStream(focusSymbol, focusInterval)
      unsubKline = socket.subscribe(stream, (raw) => {
        if (req !== focusRequestId) return
        if (get().focusSymbol !== focusSymbol || get().focusInterval !== focusInterval) return
        const msg = raw as { k?: Record<string, string | number | boolean> }
        const k = msg.k
        if (!k) return
        const candle: Candle = {
          time: Number(k.t),
          open: parseFloat(String(k.o)),
          high: parseFloat(String(k.h)),
          low: parseFloat(String(k.l)),
          close: parseFloat(String(k.c)),
          volume: parseFloat(String(k.v)),
          quoteVolume: parseFloat(String(k.q ?? '0')),
          trades: Number(k.n ?? 0),
          takerBuyBase: parseFloat(String(k.V ?? '0')),
          takerBuyQuote: parseFloat(String(k.Q ?? '0')),
        }
        const prev = get().candles
        // Never seed history from a single WS bar — wait for REST hydrate
        if (prev.length < 2) return

        const last = prev[prev.length - 1]!
        let next: Candle[]
        if (last.time === candle.time) {
          next = [...prev.slice(0, -1), candle]
        } else if (candle.time > last.time) {
          next = [...prev, candle]
        } else {
          return
        }

        candleCache.set(focusSymbol, next)
        set({ candles: next, livePrice: candle.close })

        // keep ticker lastPrice in sync for header KPIs
        const t = get().tickers.get(focusSymbol)
        if (t) {
          const tickers = new Map(get().tickers)
          tickers.set(focusSymbol, { ...t, lastPrice: candle.close })
          const tickerList = get().tickerList.map((x) =>
            x.symbol === focusSymbol ? { ...x, lastPrice: candle.close } : x,
          )
          set({ tickers, tickerList })
        }
      })
    } catch (e) {
      if (req !== focusRequestId) return
      set({ error: e instanceof Error ? e.message : 'Focus load failed' })
    }
  },
}))

