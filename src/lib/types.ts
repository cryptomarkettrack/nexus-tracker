export type Mode = 'command' | 'scanner' | 'radar' | 'focus'

export type Interval =
  | '1m'
  | '5m'
  | '15m'
  | '1h'
  | '4h'
  | '1d'
  | '1w'

export interface Ticker24h {
  symbol: string
  base: string
  lastPrice: number
  priceChange: number
  priceChangePercent: number
  highPrice: number
  lowPrice: number
  volume: number
  quoteVolume: number
  openPrice: number
  weightedAvgPrice: number
  count: number
  bidPrice: number
  askPrice: number
}

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number
  trades: number
  takerBuyBase: number
  takerBuyQuote: number
}

export interface OrderBookLevel {
  price: number
  qty: number
}

export interface OrderBook {
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  lastUpdateId: number
}

export interface FundingInfo {
  symbol: string
  fundingRate: number
  markPrice: number
  nextFundingTime: number
}

export interface OpenInterest {
  symbol: string
  openInterest: number
  time: number
}

export interface Level {
  price: number
  strength: number
  type: 'support' | 'resistance' | 'poc' | 'vah' | 'val'
  touches: number
  volume?: number
}

export type MaKind = 'EMA' | 'SMA'
export type MaPeriod = 50 | 100 | 200
export type MaTimeframe = '4h' | '1d' | '1w'

/** Multi-timeframe moving average level (latest value of that MA) */
export interface MaLevel {
  id: string
  kind: MaKind
  period: MaPeriod
  timeframe: MaTimeframe
  price: number
  /** Distance from spot: (ma - price) / price * 100 */
  distancePct: number
  label: string
}

/**
 * Soft confluence zone to watch — clusters nearby MAs / structure
 * into a band instead of many labeled lines.
 */
export interface WatchZone {
  id: string
  side: 'above' | 'below'
  low: number
  high: number
  mid: number
  strength: number
  sources: string[]
  distancePct: number
  label: string
}

export type TradeSide = 'long' | 'short' | 'flat'

/** Suggested trade framework for the focused symbol */
export interface TradePlan {
  symbol: string
  base: string
  /** Net bias */
  side: TradeSide
  /** Direction used for entry/stop/targets when side is flat */
  planSide: 'long' | 'short'
  confidence: number
  entry: number
  stop: number
  target1: number
  target2: number
  riskPct: number
  rr1: number
  rr2: number
  atr: number
  reasons: string[]
  trigger: string
  invalidation: string
  maBias: 'bullish' | 'bearish' | 'mixed'
  masBelow: number
  masAbove: number
}

/** User-opened paper/live-tracked position */
export interface Position {
  id: string
  symbol: string
  base: string
  side: 'long' | 'short'
  entry: number
  stop: number
  target1: number
  target2: number
  sizeUsd: number
  openedAt: number
  note: string
  status: 'open' | 'closed'
  closedAt?: number
  closePrice?: number
  realizedPnlUsd?: number
  /** manual chip vs autopilot */
  source?: 'manual' | 'auto'
  closeReason?: 'stop' | 'target1' | 'target2' | 'flip' | 'manual' | 'reconcile'
  /** Chart timeframe the plan/auto decision used */
  interval?: Interval
  /** Human-readable why this position opened (bias drivers, trigger, conf) */
  openReason?: string
}

/** Per-symbol paper autopilot lock (timeframe captured when user enables auto) */
export interface AutoBinding {
  symbol: string
  interval: Interval
}

export interface VolumeProfileBin {
  price: number
  volume: number
  buyVolume: number
  sellVolume: number
}

export interface VolumeProfile {
  bins: VolumeProfileBin[]
  poc: number
  vah: number
  val: number
  totalVolume: number
}

export interface CoinMetrics {
  symbol: string
  base: string
  price: number
  change24h: number
  quoteVolume: number
  volumeAnomaly: number
  relStrengthBtc: number
  rsi: number
  atr: number
  atrPct: number
  rangePosition: number
  momentumScore: number
  setup: SetupType
  setupScore: number
  setupReason: string
  distanceToHigh: number
  distanceToLow: number
  spreadBps: number
  trades: number
}

export type SetupType =
  | 'breakout'
  | 'mean-reversion'
  | 'volume-spike'
  | 'strength'
  | 'weakness'
  | 'squeeze'
  | 'neutral'

export interface MarketBreadth {
  advancing: number
  declining: number
  unchanged: number
  total: number
  advancePct: number
  avgChange: number
  medianChange: number
  volumeUp: number
  volumeDown: number
}

export interface MarketRegime {
  label: string
  bias: 'risk-on' | 'risk-off' | 'mixed' | 'volatile'
  score: number
  drivers: string[]
}

export interface SectorBucket {
  id: string
  name: string
  symbols: string[]
  avgChange: number
  totalVolume: number
  leaders: string[]
  laggards: string[]
}

export interface WatchLevel {
  symbol: string
  base: string
  price: number
  level: number
  distancePct: number
  type: Level['type']
  strength: number
  side: 'above' | 'below'
  volumeHint?: number
}

/** Pivot used as an anchor for automatic trendlines */
export interface SwingPoint {
  index: number
  time: number
  price: number
  kind: 'high' | 'low'
}

/**
 * Auto-detected trendline through swing pivots.
 * Price at bar index i: startPrice + slope * (i - startIndex)
 */
export interface Trendline {
  id: string
  type: 'support' | 'resistance'
  /** How the line was seeded */
  method: 'extreme' | 'pivot-pair'
  startIndex: number
  endIndex: number
  startTime: number
  endTime: number
  startPrice: number
  endPrice: number
  /** Price change per bar index */
  slope: number
  /** Projected price at the last candle */
  currentPrice: number
  /** Distance of last close to the line (%) */
  distancePct: number
  touches: number
  strength: number
  /** True if last close has closed through the line */
  broken: boolean
  /** Anchor pivot prices used to form the line */
  anchors: { time: number; price: number }[]
}
