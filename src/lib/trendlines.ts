import type { Candle, SwingPoint, Trendline } from './types'

export interface TrendlineOptions {
  /** Bars on each side required for a swing pivot */
  lookback?: number
  /** Max descending lines from the peak (default 1) */
  maxLines?: number
  /** Touch tolerance as fraction of price (e.g. 0.004 = 0.4%) */
  touchTolPct?: number
  /** Min bars between the peak and the second anchor */
  minSpan?: number
}

/**
 * Find swing highs / lows: local extrema over ±lookback bars.
 */
export function findSwingPoints(candles: Candle[], lookback = 3): SwingPoint[] {
  if (candles.length < lookback * 2 + 1) return []
  const points: SwingPoint[] = []

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]!
    let isHigh = true
    let isLow = true
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j]!.high >= c.high || candles[i + j]!.high >= c.high) isHigh = false
      if (candles[i - j]!.low <= c.low || candles[i + j]!.low <= c.low) isLow = false
    }
    if (isHigh) {
      points.push({ index: i, time: c.time, price: c.high, kind: 'high' })
    }
    if (isLow) {
      points.push({ index: i, time: c.time, price: c.low, kind: 'low' })
    }
  }
  return points
}

function priceAt(startIdx: number, startPrice: number, slope: number, idx: number): number {
  return startPrice + slope * (idx - startIdx)
}

function countTouches(
  candles: Candle[],
  startIdx: number,
  startPrice: number,
  slope: number,
  from: number,
  to: number,
  tolPct: number,
): number {
  let touches = 0
  for (let i = from; i <= to; i++) {
    const c = candles[i]!
    const linePx = priceAt(startIdx, startPrice, slope, i)
    if (linePx <= 0) continue
    const dist = Math.abs(c.high - linePx) / linePx
    if (dist <= tolPct) touches++
  }
  return touches
}

function respectScore(
  candles: Candle[],
  startIdx: number,
  startPrice: number,
  slope: number,
  from: number,
  to: number,
  tolPct: number,
): number {
  let ok = 0
  let n = 0
  for (let i = from; i <= to; i++) {
    const c = candles[i]!
    const linePx = priceAt(startIdx, startPrice, slope, i)
    if (linePx <= 0) continue
    n++
    // resistance: highs should stay at/below the line
    if (c.high <= linePx * (1 + tolPct * 1.5)) ok++
  }
  return n ? ok / n : 0
}

/**
 * Index of the highest high in the window.
 * On ties, prefer the most recent bar (latest peak).
 */
export function mostRecentHighestIndex(candles: Candle[]): number {
  let maxIdx = 0
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.high >= candles[maxIdx]!.high) maxIdx = i
  }
  return maxIdx
}

/**
 * Detect descending resistance trendlines from the most recent highest high only.
 *
 * Algorithm:
 * 1. Find the peak high in the window (latest bar wins ties)
 * 2. Connect that peak to later lower swing highs
 * 3. Keep the single best line by touches + respect + proximity to last price
 */
export function detectTrendlines(
  candles: Candle[],
  opts: TrendlineOptions = {},
): Trendline[] {
  const lookback = opts.lookback ?? 3
  const maxLines = opts.maxLines ?? 1
  const touchTolPct = opts.touchTolPct ?? 0.0045
  const minSpan = opts.minSpan ?? 5

  if (candles.length < lookback * 2 + 10) return []

  const peakIdx = mostRecentHighestIndex(candles)
  // Need room after the peak for a descending structure
  if (peakIdx >= candles.length - minSpan - 1) return []

  const peakPrice = candles[peakIdx]!.high
  const peakTime = candles[peakIdx]!.time
  const last = candles.length - 1
  const close = candles[last]!.close

  const pivots = findSwingPoints(candles, lookback)
  const laterHighs = pivots.filter(
    (p) => p.kind === 'high' && p.index >= peakIdx + minSpan && p.price < peakPrice,
  )

  // Also consider significant later bars that aren't formal pivots (every Nth local high)
  // so we still get a line when pivot lookback is strict
  if (laterHighs.length < 2) {
    for (let i = peakIdx + minSpan; i < candles.length - 1; i++) {
      const h = candles[i]!.high
      if (h >= peakPrice) continue
      const isLocal =
        h >= candles[i - 1]!.high && h >= candles[i + 1]!.high
      if (isLocal) {
        laterHighs.push({
          index: i,
          time: candles[i]!.time,
          price: h,
          kind: 'high',
        })
      }
    }
  }

  type Cand = {
    i1: number
    p1: number
    slope: number
    touches: number
    respect: number
    score: number
    currentPrice: number
  }

  const candidates: Cand[] = []

  for (const h of laterHighs) {
    const slope = (h.price - peakPrice) / (h.index - peakIdx)
    // Must slope down (or flat-ish)
    if (slope > peakPrice * 0.0005) continue

    const absPctPerBar = Math.abs(slope) / peakPrice
    if (absPctPerBar > 0.12) continue

    const currentPrice = priceAt(peakIdx, peakPrice, slope, last)
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue

    const distPct = Math.abs(close - currentPrice) / close
    // Only keep lines that still matter near current price
    if (distPct > 0.1) continue

    const touches = countTouches(
      candles,
      peakIdx,
      peakPrice,
      slope,
      peakIdx,
      last,
      touchTolPct,
    )
    // Peak + at least one more touch preferred; allow 1 pivot pair with good respect
    if (touches < 2) continue

    const respect = respectScore(
      candles,
      peakIdx,
      peakPrice,
      slope,
      peakIdx,
      last,
      touchTolPct,
    )
    if (respect < 0.5) continue

    const proximity = distPct < 0.02 ? 1.4 : distPct < 0.05 ? 1.15 : 1
    const spanBoost = Math.min(1.3, (h.index - peakIdx) / 35)
    const score = respect * 40 + touches * 14 + spanBoost * 12 * proximity

    candidates.push({
      i1: h.index,
      p1: h.price,
      slope,
      touches,
      respect,
      score,
      currentPrice,
    })
  }

  if (!candidates.length) return []

  // Dedupe similar slopes / projected levels
  candidates.sort((a, b) => b.score - a.score)
  const kept: Cand[] = []
  for (const c of candidates) {
    const dup = kept.some((k) => {
      const levelClose =
        Math.abs(k.currentPrice - c.currentPrice) / Math.max(c.currentPrice, 1e-12) < 0.006
      const slopeClose =
        Math.abs(k.slope - c.slope) / Math.max(Math.abs(c.slope), peakPrice * 1e-6) < 0.3
      return levelClose || slopeClose
    })
    if (!dup) kept.push(c)
  }

  return kept.slice(0, maxLines).map((c, n) => {
    const broken = close > c.currentPrice * (1 + touchTolPct)
    const distancePct = ((c.currentPrice - close) / close) * 100
    return {
      id: `resistance-extreme-${peakIdx}-${c.i1}-${n}`,
      type: 'resistance' as const,
      method: 'extreme' as const,
      startIndex: peakIdx,
      endIndex: c.i1,
      startTime: peakTime,
      endTime: candles[c.i1]!.time,
      startPrice: peakPrice,
      endPrice: c.p1,
      slope: c.slope,
      currentPrice: c.currentPrice,
      distancePct,
      touches: c.touches,
      strength: Math.min(1, c.score / 100),
      broken,
      anchors: [
        { time: peakTime, price: peakPrice },
        { time: candles[c.i1]!.time, price: c.p1 },
      ],
    }
  })
}

/** Sample a trendline as chart points from start through last bar (+ optional forward bars). */
export function sampleTrendline(
  tl: Trendline,
  candles: Candle[],
  extendBars = 8,
): { time: number; value: number }[] {
  if (!candles.length) return []
  const points: { time: number; value: number }[] = []
  const lastIdx = candles.length - 1
  const step = Math.max(1, Math.floor((lastIdx - tl.startIndex) / 24))

  for (let i = tl.startIndex; i <= lastIdx; i += step) {
    const v = priceAt(tl.startIndex, tl.startPrice, tl.slope, i)
    points.push({ time: candles[i]!.time, value: v })
  }
  const lastV = priceAt(tl.startIndex, tl.startPrice, tl.slope, lastIdx)
  if (points[points.length - 1]?.time !== candles[lastIdx]!.time) {
    points.push({ time: candles[lastIdx]!.time, value: lastV })
  }

  if (extendBars > 0 && candles.length >= 2) {
    const dt = candles[lastIdx]!.time - candles[lastIdx - 1]!.time
    for (let k = 1; k <= extendBars; k++) {
      const v = priceAt(tl.startIndex, tl.startPrice, tl.slope, lastIdx + k)
      points.push({ time: candles[lastIdx]!.time + dt * k, value: v })
    }
  }

  return points
}

/**
 * Pick the single nearest horizontal level above and below price (max 2).
 */
export function nearestChartLevels<T extends { price: number }>(
  levels: T[],
  price: number,
  maxTotal = 2,
): T[] {
  if (!levels.length || !price) return []

  const above = levels
    .filter((l) => l.price >= price)
    .sort((a, b) => a.price - b.price)
  const below = levels
    .filter((l) => l.price < price)
    .sort((a, b) => b.price - a.price)

  const picked: T[] = []
  if (above[0]) picked.push(above[0])
  if (below[0]) picked.push(below[0])

  // If we only want 1 overall, keep the closer of the two
  if (maxTotal === 1 && picked.length === 2) {
    const d0 = Math.abs(picked[0]!.price - price)
    const d1 = Math.abs(picked[1]!.price - price)
    return d0 <= d1 ? [picked[0]!] : [picked[1]!]
  }

  return picked.slice(0, maxTotal)
}
