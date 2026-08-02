import type {
  Candle,
  CoinMetrics,
  Level,
  MarketBreadth,
  MarketRegime,
  SetupType,
  Ticker24h,
  VolumeProfile,
  VolumeProfileBin,
  WatchLevel,
} from './types'

export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  let gains = 0
  let losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!
    if (d >= 0) gains += d
    else losses -= d
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) {
    const last = candles[candles.length - 1]
    return last ? last.high - last.low : 0
  }
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!
    const p = candles[i - 1]!
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)))
  }
  const slice = trs.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / slice.length
}

export function sma(values: number[], period: number): number {
  if (values.length < period) {
    if (!values.length) return 0
    return values.reduce((a, b) => a + b, 0) / values.length
  }
  const slice = values.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const v = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(v)
}

/** Swing high/low support & resistance with touch counting */
export function findSwingLevels(candles: Candle[], lookback = 3, maxLevels = 8): Level[] {
  if (candles.length < lookback * 2 + 1) return []
  const swings: { price: number; type: 'support' | 'resistance'; idx: number }[] = []

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]!
    let isHigh = true
    let isLow = true
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j]!.high >= c.high || candles[i + j]!.high >= c.high) isHigh = false
      if (candles[i - j]!.low <= c.low || candles[i + j]!.low <= c.low) isLow = false
    }
    if (isHigh) swings.push({ price: c.high, type: 'resistance', idx: i })
    if (isLow) swings.push({ price: c.low, type: 'support', idx: i })
  }

  // Cluster nearby swings
  const last = candles[candles.length - 1]!
  const tolerance = (last.high - last.low || last.close * 0.01) * 0.15 || last.close * 0.003
  const clusters: Level[] = []

  const sorted = [...swings].sort((a, b) => a.price - b.price)
  for (const s of sorted) {
    const existing = clusters.find((cl) => Math.abs(cl.price - s.price) <= tolerance)
    if (existing) {
      existing.price = (existing.price * existing.touches + s.price) / (existing.touches + 1)
      existing.touches += 1
      existing.strength = Math.min(1, existing.touches / 5)
      if (s.type === existing.type) {
        // keep
      } else {
        // mixed cluster — classify by price vs current
        existing.type = existing.price >= last.close ? 'resistance' : 'support'
      }
    } else {
      clusters.push({
        price: s.price,
        type: s.type,
        touches: 1,
        strength: 0.25,
      })
    }
  }

  // Score by proximity + touches + recency weight via volume around level
  const scored = clusters
    .map((cl) => {
      const dist = Math.abs(cl.price - last.close) / last.close
      const proximityBoost = dist < 0.08 ? 1.2 : dist < 0.15 ? 1 : 0.7
      return {
        ...cl,
        strength: Math.min(1, cl.strength * proximityBoost + (cl.touches > 2 ? 0.15 : 0)),
      }
    })
    .sort((a, b) => b.strength - a.strength)
    .slice(0, maxLevels)

  return scored.sort((a, b) => a.price - b.price)
}

/** Fixed-range volume profile with POC / VAH / VAL (70% value area) */
export function volumeProfile(candles: Candle[], bins = 48): VolumeProfile {
  if (!candles.length) {
    return { bins: [], poc: 0, vah: 0, val: 0, totalVolume: 0 }
  }
  let min = Infinity
  let max = -Infinity
  for (const c of candles) {
    min = Math.min(min, c.low)
    max = Math.max(max, c.high)
  }
  if (min === max) max = min * 1.001
  const step = (max - min) / bins
  const profile: VolumeProfileBin[] = Array.from({ length: bins }, (_, i) => ({
    price: min + step * (i + 0.5),
    volume: 0,
    buyVolume: 0,
    sellVolume: 0,
  }))

  let totalVolume = 0
  for (const c of candles) {
    const mid = (c.high + c.low) / 2
    let idx = Math.floor((mid - min) / step)
    if (idx < 0) idx = 0
    if (idx >= bins) idx = bins - 1
    const buyRatio = c.volume > 0 ? c.takerBuyBase / c.volume : 0.5
    profile[idx]!.volume += c.volume
    profile[idx]!.buyVolume += c.volume * buyRatio
    profile[idx]!.sellVolume += c.volume * (1 - buyRatio)
    totalVolume += c.volume
  }

  let pocIdx = 0
  for (let i = 1; i < profile.length; i++) {
    if (profile[i]!.volume > profile[pocIdx]!.volume) pocIdx = i
  }
  const poc = profile[pocIdx]!.price

  // Value area: expand from POC until ~70% volume
  let vaVol = profile[pocIdx]!.volume
  let lo = pocIdx
  let hi = pocIdx
  const target = totalVolume * 0.7
  while (vaVol < target && (lo > 0 || hi < bins - 1)) {
    const nextLo = lo > 0 ? profile[lo - 1]!.volume : -1
    const nextHi = hi < bins - 1 ? profile[hi + 1]!.volume : -1
    if (nextHi >= nextLo) {
      hi++
      vaVol += profile[hi]!.volume
    } else {
      lo--
      vaVol += profile[lo]!.volume
    }
  }

  return {
    bins: profile,
    poc,
    vah: profile[hi]!.price,
    val: profile[lo]!.price,
    totalVolume,
  }
}

export function profileLevels(vp: VolumeProfile): Level[] {
  if (!vp.bins.length) return []
  return [
    { price: vp.vah, type: 'vah', strength: 0.7, touches: 0, volume: 0 },
    { price: vp.poc, type: 'poc', strength: 1, touches: 0, volume: vp.bins.reduce((m, b) => Math.max(m, b.volume), 0) },
    { price: vp.val, type: 'val', strength: 0.7, touches: 0, volume: 0 },
  ]
}

export function marketBreadth(tickers: Ticker24h[]): MarketBreadth {
  let advancing = 0
  let declining = 0
  let unchanged = 0
  let volumeUp = 0
  let volumeDown = 0
  const changes: number[] = []
  for (const t of tickers) {
    changes.push(t.priceChangePercent)
    if (t.priceChangePercent > 0.05) {
      advancing++
      volumeUp += t.quoteVolume
    } else if (t.priceChangePercent < -0.05) {
      declining++
      volumeDown += t.quoteVolume
    } else {
      unchanged++
    }
  }
  const total = tickers.length || 1
  const sorted = [...changes].sort((a, b) => a - b)
  const median = sorted.length
    ? sorted[Math.floor(sorted.length / 2)]!
    : 0
  const avg = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0
  return {
    advancing,
    declining,
    unchanged,
    total,
    advancePct: (advancing / total) * 100,
    avgChange: avg,
    medianChange: median,
    volumeUp,
    volumeDown,
  }
}

export function detectRegime(
  btc: Ticker24h | undefined,
  eth: Ticker24h | undefined,
  breadth: MarketBreadth,
  fundingAvg: number,
): MarketRegime {
  const drivers: string[] = []
  let score = 0

  if (btc) {
    if (btc.priceChangePercent > 1.5) {
      score += 2
      drivers.push(`BTC +${btc.priceChangePercent.toFixed(2)}% leading risk`)
    } else if (btc.priceChangePercent < -1.5) {
      score -= 2
      drivers.push(`BTC ${btc.priceChangePercent.toFixed(2)}% risk-off pressure`)
    } else {
      drivers.push(`BTC flat (${btc.priceChangePercent.toFixed(2)}%) — range day`)
    }
  }

  if (eth && btc) {
    const ethOut = eth.priceChangePercent - btc.priceChangePercent
    if (ethOut > 1) {
      score += 1
      drivers.push(`ETH outperforming BTC by ${ethOut.toFixed(2)}pp`)
    } else if (ethOut < -1) {
      score -= 0.5
      drivers.push(`ETH lagging BTC by ${Math.abs(ethOut).toFixed(2)}pp`)
    }
  }

  if (breadth.advancePct > 60) {
    score += 1.5
    drivers.push(`Breadth strong: ${breadth.advancePct.toFixed(0)}% advancing`)
  } else if (breadth.advancePct < 40) {
    score -= 1.5
    drivers.push(`Breadth weak: ${breadth.advancePct.toFixed(0)}% advancing`)
  }

  const volRatio =
    breadth.volumeDown > 0 ? breadth.volumeUp / breadth.volumeDown : breadth.volumeUp > 0 ? 2 : 1
  if (volRatio > 1.4) {
    score += 0.5
    drivers.push('Up-volume dominates')
  } else if (volRatio < 0.7) {
    score -= 0.5
    drivers.push('Down-volume dominates')
  }

  if (fundingAvg > 0.0003) {
    score -= 0.5
    drivers.push(`Crowded longs (funding ${(fundingAvg * 100).toFixed(3)}%)`)
  } else if (fundingAvg < -0.0001) {
    score += 0.5
    drivers.push(`Crowded shorts (funding ${(fundingAvg * 100).toFixed(3)}%)`)
  }

  const absAvg = Math.abs(breadth.avgChange)
  let bias: MarketRegime['bias'] = 'mixed'
  let label = 'Balanced / Range'

  if (absAvg > 3 && breadth.advancePct > 30 && breadth.advancePct < 70) {
    bias = 'volatile'
    label = 'High dispersion'
    drivers.push('Elevated cross-sectional volatility')
  } else if (score >= 2) {
    bias = 'risk-on'
    label = score >= 3.5 ? 'Risk-on expansion' : 'Mild risk-on'
  } else if (score <= -2) {
    bias = 'risk-off'
    label = score <= -3.5 ? 'Risk-off flush' : 'Mild risk-off'
  }

  return { label, bias, score, drivers: drivers.slice(0, 5) }
}

function classifySetup(m: {
  change24h: number
  volumeAnomaly: number
  rsi: number
  rangePosition: number
  relStrengthBtc: number
  distanceToHigh: number
}): { setup: SetupType; score: number; reason: string } {
  const candidates: { setup: SetupType; score: number; reason: string }[] = []

  if (m.volumeAnomaly > 2.2 && m.change24h > 2 && m.distanceToHigh < 3) {
    candidates.push({
      setup: 'breakout',
      score: Math.min(100, 55 + m.volumeAnomaly * 8 + m.change24h),
      reason: `Volume ${m.volumeAnomaly.toFixed(1)}× avg near 24h high — breakout watch`,
    })
  }
  if (m.volumeAnomaly > 2.5 && Math.abs(m.change24h) > 1.5) {
    candidates.push({
      setup: 'volume-spike',
      score: Math.min(100, 50 + m.volumeAnomaly * 10),
      reason: `Unusual volume ${m.volumeAnomaly.toFixed(1)}× with ${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(1)}% move`,
    })
  }
  if (m.rsi < 32 && m.rangePosition < 0.25 && m.volumeAnomaly > 1.2) {
    candidates.push({
      setup: 'mean-reversion',
      score: Math.min(100, 45 + (32 - m.rsi) + (1 - m.rangePosition) * 20),
      reason: `RSI ${m.rsi.toFixed(0)} near range lows — bounce candidate`,
    })
  }
  if (m.rsi > 70 && m.rangePosition > 0.85) {
    candidates.push({
      setup: 'mean-reversion',
      score: Math.min(100, 40 + (m.rsi - 70) + m.rangePosition * 15),
      reason: `RSI ${m.rsi.toFixed(0)} at range highs — fade / pullback zone`,
    })
  }
  if (m.relStrengthBtc > 3 && m.change24h > 0) {
    candidates.push({
      setup: 'strength',
      score: Math.min(100, 50 + m.relStrengthBtc * 4),
      reason: `Outperforming BTC by ${m.relStrengthBtc.toFixed(1)}pp — relative strength`,
    })
  }
  if (m.relStrengthBtc < -3 && m.change24h < 0) {
    candidates.push({
      setup: 'weakness',
      score: Math.min(100, 45 + Math.abs(m.relStrengthBtc) * 3),
      reason: `Underperforming BTC by ${Math.abs(m.relStrengthBtc).toFixed(1)}pp — relative weakness`,
    })
  }
  if (m.volumeAnomaly < 0.6 && Math.abs(m.change24h) < 1.2) {
    candidates.push({
      setup: 'squeeze',
      score: 40 + (1 - m.volumeAnomaly) * 20,
      reason: 'Compressed range + thin volume — expansion setup',
    })
  }

  if (!candidates.length) {
    return { setup: 'neutral', score: 20, reason: 'No standout setup — monitor levels' }
  }
  return candidates.sort((a, b) => b.score - a.score)[0]!
}

/** Percent change + range stats over a candle window (for SCAN TFs). */
export function candleWindowStats(candles: Candle[]): {
  changePct: number
  rangePosition: number
  distanceToHigh: number
  distanceToLow: number
  last: number
} | null {
  if (!candles.length) return null
  const first = candles[0]!
  const lastC = candles[candles.length - 1]!
  const last = lastC.close
  const open = first.open > 0 ? first.open : first.close
  let hi = -Infinity
  let lo = Infinity
  for (const c of candles) {
    if (c.high > hi) hi = c.high
    if (c.low < lo) lo = c.low
  }
  if (!(hi > lo) || !(open > 0) || !(last > 0)) return null
  const range = hi - lo
  return {
    changePct: ((last - open) / open) * 100,
    rangePosition: (last - lo) / range,
    distanceToHigh: ((hi - last) / hi) * 100,
    distanceToLow: ((last - lo) / last) * 100,
    last,
  }
}

export function buildCoinMetrics(
  ticker: Ticker24h,
  candles: Candle[] | undefined,
  btcChange: number,
  avgQuoteVolume: number,
  opts?: { scanInterval?: import('./types').Interval },
): CoinMetrics {
  const closes = candles?.map((c) => c.close) ?? []
  const vols = candles?.map((c) => c.quoteVolume) ?? []
  const r = closes.length ? rsi(closes) : 50
  const a = candles?.length ? atr(candles) : ticker.highPrice - ticker.lowPrice
  const price = ticker.lastPrice || closes[closes.length - 1] || 0
  const atrPct = price > 0 ? (a / price) * 100 : 0

  // Prefer TF window when we have enough candles (SCAN); else 24h ticker book
  const win = candles && candles.length >= 10 ? candleWindowStats(candles) : null
  const changePct = win?.changePct ?? ticker.priceChangePercent
  const rangePosition =
    win?.rangePosition ??
    (ticker.highPrice - ticker.lowPrice > 0
      ? (ticker.lastPrice - ticker.lowPrice) / (ticker.highPrice - ticker.lowPrice)
      : 0.5)
  const distanceToHigh =
    win?.distanceToHigh ??
    (ticker.highPrice > 0 ? ((ticker.highPrice - ticker.lastPrice) / ticker.highPrice) * 100 : 0)
  const distanceToLow =
    win?.distanceToLow ??
    (ticker.lastPrice > 0 ? ((ticker.lastPrice - ticker.lowPrice) / ticker.lastPrice) * 100 : 0)

  const volMean = vols.length ? sma(vols, Math.min(20, vols.length)) : avgQuoteVolume
  const volumeAnomaly =
    volMean > 0
      ? ticker.quoteVolume / (volMean * (vols.length ? 1 : 1) || avgQuoteVolume || 1)
      : ticker.quoteVolume / (avgQuoteVolume || 1)
  // Prefer candle-based anomaly when available
  const lastCandleVol = vols.length ? vols[vols.length - 1]! : 0
  const candleAnomaly = volMean > 0 && lastCandleVol > 0 ? lastCandleVol / volMean : volumeAnomaly
  const va = candles?.length ? candleAnomaly : volumeAnomaly

  const relStrengthBtc = changePct - btcChange
  const spreadBps =
    ticker.lastPrice > 0 && ticker.bidPrice && ticker.askPrice
      ? ((ticker.askPrice - ticker.bidPrice) / ticker.lastPrice) * 10000
      : 0

  const setup = classifySetup({
    change24h: changePct,
    volumeAnomaly: va,
    rsi: r,
    rangePosition,
    relStrengthBtc,
    distanceToHigh,
  })

  const momentumScore = Math.max(
    0,
    Math.min(
      100,
      50 + changePct * 3 + relStrengthBtc * 2 + (r - 50) * 0.4 + (va > 1.5 ? 8 : 0),
    ),
  )

  return {
    symbol: ticker.symbol,
    base: ticker.base,
    price: ticker.lastPrice,
    change24h: changePct,
    quoteVolume: ticker.quoteVolume,
    volumeAnomaly: va,
    relStrengthBtc,
    rsi: r,
    atr: a,
    atrPct,
    rangePosition,
    momentumScore,
    setup: setup.setup,
    setupScore: setup.score,
    setupReason: setup.reason,
    distanceToHigh,
    distanceToLow,
    spreadBps,
    trades: ticker.count,
    scanInterval: opts?.scanInterval,
  }
}

export function nearestWatchLevels(
  symbol: string,
  base: string,
  price: number,
  levels: Level[],
  max = 4,
): WatchLevel[] {
  return levels
    .map((l) => ({
      symbol,
      base,
      price,
      level: l.price,
      distancePct: ((l.price - price) / price) * 100,
      type: l.type,
      strength: l.strength,
      side: (l.price >= price ? 'above' : 'below') as 'above' | 'below',
      volumeHint: l.volume,
    }))
    .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))
    .slice(0, max)
}

export function formatPrice(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (abs >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
  if (abs >= 0.01) return n.toFixed(5)
  return n.toPrecision(4)
}

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`
  return `${sign}${abs.toFixed(0)}`
}

export function formatPct(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—'
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(digits)}%`
}
