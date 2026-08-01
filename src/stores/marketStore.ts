import { create } from 'zustand'
import {
  AUTO_SIZE_USD,
  backfillAutoTrades,
  decideAutoOpen,
  decideCandleExit,
  decideFlipExit,
  decideLiveExit,
  entryIsReachable,
  isAutoActiveOnInterval,
  isAutoEnabled,
} from '../lib/autoTrader'
import { describePlanOpen, levelsForFill } from '../lib/tradePlan'
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
  AutoBinding,
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
  Position,
  SectorBucket,
  Ticker24h,
  TradePlan,
  Trendline,
  VolumeProfile,
  WatchLevel,
  WatchZone,
} from '../lib/types'

const boot = readBootParams()

const POSITIONS_KEY = 'nexus-positions-v1'
const AUTO_BINDINGS_KEY = 'nexus-auto-bindings-v1'
/** Legacy key (symbol list only) — migrated once */
const AUTO_SYMBOLS_KEY = 'nexus-auto-symbols-v1'
const AUTO_AWAY_KEY = 'nexus-auto-away-v1'
const LAST_SEEN_KEY = 'nexus-last-seen-v1'

const INTERVALS: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w']

function isInterval(v: unknown): v is Interval {
  return typeof v === 'string' && (INTERVALS as string[]).includes(v)
}

function loadPositions(): Position[] {
  try {
    const raw = localStorage.getItem(POSITIONS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Position[]
    if (!Array.isArray(parsed)) return []
    return parsed.map((p) => ({
      ...p,
      source: p.source ?? 'manual',
    }))
  } catch {
    return []
  }
}

function savePositions(positions: Position[]) {
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions))
  } catch {
    /* ignore quota */
  }
}

function loadAutoBindings(): AutoBinding[] {
  try {
    const raw = localStorage.getItem(AUTO_BINDINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        return parsed
          .map((b) => {
            if (!b || typeof b !== 'object') return null
            const o = b as { symbol?: unknown; interval?: unknown }
            if (typeof o.symbol !== 'string' || !isInterval(o.interval)) return null
            return { symbol: o.symbol, interval: o.interval } satisfies AutoBinding
          })
          .filter((b): b is AutoBinding => b != null)
      }
    }
    // migrate legacy symbol-only list → default 1d lock
    const legacy = localStorage.getItem(AUTO_SYMBOLS_KEY)
    if (legacy) {
      const parsed = JSON.parse(legacy) as unknown
      if (Array.isArray(parsed)) {
        const migrated = parsed
          .filter((s): s is string => typeof s === 'string')
          .map((symbol) => ({ symbol, interval: '1d' as Interval }))
        saveAutoBindings(migrated)
        return migrated
      }
    }
    return []
  } catch {
    return []
  }
}

function saveAutoBindings(bindings: AutoBinding[]) {
  try {
    localStorage.setItem(AUTO_BINDINGS_KEY, JSON.stringify(bindings))
  } catch {
    /* ignore */
  }
}

function loadAwaySince(): number {
  try {
    const raw = localStorage.getItem(LAST_SEEN_KEY)
    if (!raw) return Date.now() - 24 * 60 * 60_000
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? n : Date.now() - 24 * 60 * 60_000
  } catch {
    return Date.now() - 24 * 60 * 60_000
  }
}

function touchLastSeen() {
  try {
    localStorage.setItem(LAST_SEEN_KEY, String(Date.now()))
  } catch {
    /* ignore */
  }
}

function loadAwayMarker(): number {
  try {
    const raw = localStorage.getItem(AUTO_AWAY_KEY)
    if (raw) {
      const n = parseInt(raw, 10)
      if (Number.isFinite(n)) return n
    }
  } catch {
    /* ignore */
  }
  const away = loadAwaySince()
  try {
    localStorage.setItem(AUTO_AWAY_KEY, String(away))
  } catch {
    /* ignore */
  }
  return away
}

const socket = new BinanceSocket()

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
  setFocusSymbol: (s: string) => void
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
  positions: Position[]
  defaultSizeUsd: number
  /** Autopilot bindings: symbol → locked timeframe (set when user enables auto) */
  autoBindings: AutoBinding[]
  /** Session marker: closed trades after this count as “while away” */
  autoAwaySince: number
  scannerFilter: 'all' | 'breakout' | 'volume-spike' | 'strength' | 'mean-reversion' | 'squeeze'
  setScannerFilter: (f: MarketState['scannerFilter']) => void
  setDefaultSizeUsd: (n: number) => void
  /**
   * Toggle autopilot for symbol. When enabling, locks `interval` (current chart TF).
   * Autopilot only opens/flips using plans from that timeframe.
   */
  toggleAuto: (symbol: string, interval: Interval) => void
  openPosition: (
    p: Omit<Position, 'id' | 'openedAt' | 'status'> & { source?: 'manual' | 'auto' },
  ) => void
  closePosition: (
    id: string,
    mark: number,
    reason?: Position['closeReason'],
    closedAt?: number,
  ) => void
  /** Manage open stops/targets from live marks (all symbols) */
  tickPositionExits: () => void
  /** Open/close autopilot for the focused symbol using current plan inputs */
  runAutoForFocus: (plan: TradePlan | null) => void
  lastRefresh: number
  bootstrap: () => Promise<void>
  refreshFocus: () => Promise<void>
  hydrateMetrics: () => void
}

let unsubTicker: (() => void) | null = null
let unsubKline: (() => void) | null = null
let metricsTimer: ReturnType<typeof setInterval> | null = null
let fundingTimer: ReturnType<typeof setInterval> | null = null
let exitTickTimer: ReturnType<typeof setInterval> | null = null
let candleCache = new Map<string, Candle[]>()
let bootstrapped = false
let bootstrapPromise: Promise<void> | null = null
let focusRequestId = 0
/** Avoid double-backfill per symbol per session */
const backfilledSymbols = new Set<string>()
/** Candle reconcile once per open position id per session */
const reconciledIds = new Set<string>()
let lastExitTick = 0

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
  setFocusSymbol: (s) => {
    set({ focusSymbol: s, mode: 'focus' })
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
  positions: loadPositions(),
  defaultSizeUsd: 1000,
  autoBindings: loadAutoBindings(),
  autoAwaySince: loadAwayMarker(),
  scannerFilter: 'all',
  setScannerFilter: (f) => set({ scannerFilter: f }),
  setDefaultSizeUsd: (n) => set({ defaultSizeUsd: Math.max(10, n) }),
  toggleAuto: (symbol, interval) => {
    const cur = get().autoBindings
    const existing = cur.find((b) => b.symbol === symbol)
    const autoBindings = existing
      ? cur.filter((b) => b.symbol !== symbol)
      : [...cur.filter((b) => b.symbol !== symbol), { symbol, interval }]
    saveAutoBindings(autoBindings)
    set({ autoBindings })
    if (!existing) {
      // Enabling on this TF: refresh so plan matches locked interval
      if (get().focusInterval !== interval) {
        get().setFocusInterval(interval)
      } else {
        void get().refreshFocus()
      }
    }
  },
  openPosition: (p) => {
    const pos: Position = {
      ...p,
      source: p.source ?? 'manual',
      interval: p.interval ?? get().focusInterval,
      openReason: p.openReason ?? p.note,
      id: `${p.source === 'auto' ? 'auto-' : ''}${p.symbol}-${Date.now()}`,
      openedAt: Date.now(),
      status: 'open',
    }
    const positions = [pos, ...get().positions].slice(0, 80)
    savePositions(positions)
    set({ positions })
  },
  closePosition: (id, mark, reason = 'manual', closedAt) => {
    const positions = get().positions.map((p) => {
      if (p.id !== id || p.status !== 'open') return p
      const pnlPct =
        p.side === 'long'
          ? ((mark - p.entry) / p.entry) * 100
          : ((p.entry - mark) / p.entry) * 100
      return {
        ...p,
        status: 'closed' as const,
        closedAt: closedAt ?? Date.now(),
        closePrice: mark,
        realizedPnlUsd: (pnlPct / 100) * p.sizeUsd,
        closeReason: reason,
      }
    })
    savePositions(positions)
    set({ positions })
  },

  tickPositionExits: () => {
    const now = Date.now()
    if (now - lastExitTick < 1500) return
    lastExitTick = now
    touchLastSeen()

    const { positions, tickers, livePrice, focusSymbol } = get()
    const open = positions.filter((p) => p.status === 'open')
    if (!open.length) return

    for (const p of open) {
      const mark =
        p.symbol === focusSymbol && livePrice != null && livePrice > 0
          ? livePrice
          : tickers.get(p.symbol)?.lastPrice
      if (mark == null || mark <= 0) continue
      const exit = decideLiveExit(p, mark)
      if (exit?.exit) {
        get().closePosition(p.id, exit.price, exit.reason)
      }
    }
  },

  runAutoForFocus: (plan) => {
    const {
      focusSymbol,
      focusInterval,
      autoBindings,
      positions,
      livePrice,
      tickers,
      candles,
    } = get()
    if (!isAutoEnabled(autoBindings, focusSymbol)) return

    // Plan-driven opens/flips only on the timeframe locked when auto was enabled
    const onLockedTf = isAutoActiveOnInterval(autoBindings, focusSymbol, focusInterval)
    const lockedInterval =
      autoBindings.find((b) => b.symbol === focusSymbol)?.interval ?? focusInterval

    const mark =
      livePrice ?? tickers.get(focusSymbol)?.lastPrice ?? plan?.entry ?? 0
    if (!mark || mark <= 0) return

    // 1) Reconcile + price exits always; bias flip only on locked TF plan
    const openHere = positions.filter(
      (p) => p.status === 'open' && p.symbol === focusSymbol,
    )
    for (const p of openHere) {
      if (!reconciledIds.has(p.id) && candles.length) {
        reconciledIds.add(p.id)
        const candleExit = decideCandleExit(p, candles)
        if (candleExit?.exit) {
          get().closePosition(p.id, candleExit.price, candleExit.reason, candleExit.at)
          continue
        }
      }
      const live = decideLiveExit(p, mark)
      if (live?.exit) {
        get().closePosition(p.id, live.price, live.reason)
        continue
      }
      if (onLockedTf && p.source === 'auto' && plan) {
        // Only flip using the locked timeframe's plan
        if (!p.interval || p.interval === focusInterval) {
          const flip = decideFlipExit(p, plan)
          if (flip?.exit) {
            get().closePosition(p.id, mark, 'flip')
          }
        }
      }
    }

    if (!onLockedTf) return

    // 2) One-shot historical backfill for this symbol+TF
    const bfKey = `${focusSymbol}:${focusInterval}`
    if (!backfilledSymbols.has(bfKey) && candles.length >= 40) {
      backfilledSymbols.add(bfKey)
      const filled = backfillAutoTrades({
        symbol: focusSymbol,
        base: focusSymbol.replace('USDT', ''),
        candles,
        sizeUsd: AUTO_SIZE_USD,
        interval: focusInterval,
        existing: get().positions,
      })
      if (filled.length) {
        const merged = [...filled, ...get().positions].slice(0, 80)
        savePositions(merged)
        set({ positions: merged })
      }
    }

    // 3) Open new auto position from plan on locked TF
    const decision = decideAutoOpen(plan, get().positions)
    if (decision.open && decision.side && plan) {
      // Don't chase: only fill when mark is near the planned entry / trigger
      if (!entryIsReachable(plan, mark)) return
      // Rebuild stop/targets from the actual fill so geometry never inverts
      const levels = levelsForFill(decision.side, mark, plan)
      const openReason = describePlanOpen(plan, lockedInterval, 'auto')
      get().openPosition({
        symbol: focusSymbol,
        base: plan.base,
        side: decision.side,
        entry: mark,
        stop: levels.stop,
        target1: levels.target1,
        target2: levels.target2,
        sizeUsd: AUTO_SIZE_USD,
        note: plan.reasons[0] ?? plan.trigger,
        openReason,
        interval: lockedInterval,
        source: 'auto',
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
    get().tickPositionExits()
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

          if (exitTickTimer) clearInterval(exitTickTimer)
          exitTickTimer = setInterval(() => get().tickPositionExits(), 3_000)

          // Reconcile any open positions that may have hit stop/T1 while offline
          void (async () => {
            const open = get().positions.filter((p) => p.status === 'open')
            for (const p of open) {
              try {
                const kl = candleCache.get(p.symbol) ?? (await fetchKlines(p.symbol, '1h', 48))
                candleCache.set(p.symbol, kl)
                reconciledIds.add(p.id)
                const exit = decideCandleExit(p, kl)
                if (exit?.exit) {
                  get().closePosition(p.id, exit.price, exit.reason, exit.at)
                }
              } catch {
                /* skip */
              }
              await sleep(100)
            }
            get().tickPositionExits()
          })()

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
    try {
      const [candles, ...maTfCandles] = await Promise.all([
        fetchKlines(focusSymbol, focusInterval, FOCUS_KLINE_LIMIT),
        ...MA_TIMEFRAMES.map((tf) =>
          fetchKlines(focusSymbol, tf, MA_KLINE_LIMIT).catch(() => [] as Candle[]),
        ),
      ])
      if (req !== focusRequestId) return

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
        touchTolPct: 0.0045,
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
      if (unsubKline) {
        unsubKline()
        unsubKline = null
      }
      const stream = klineStream(focusSymbol, focusInterval)
      unsubKline = socket.subscribe(stream, (raw) => {
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
        if (!prev.length) {
          set({ candles: [candle], livePrice: candle.close })
          return
        }
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

        // Autopilot: manage exits on live prints
        get().tickPositionExits()
      })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Focus load failed' })
    }
  },
}))

