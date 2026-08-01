import type { Candle, SwingPoint, Trendline } from './types'

export interface TrendlineOptions {
  /** Bars on each side required for a swing pivot */
  lookback?: number
  /** Max descending lines from the peak (default 1) */
  maxLines?: number
  /** Touch tolerance as fraction of price (e.g. 0.006 = 0.6%) */
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
 * Candidate middle/end anchors after the peak: swing highs + segment maxima.
 * Every candidate price is a real candle high so middle points sit on highs.
 */
function collectPostPeakHighs(
  candles: Candle[],
  peakIdx: number,
  peakPrice: number,
  lookback: number,
  minSpan: number,
): SwingPoint[] {
  const byIndex = new Map<number, SwingPoint>()
  const last = candles.length - 1

  const add = (index: number) => {
    if (index < peakIdx + minSpan || index > last) return
    const price = candles[index]!.high
    // Must be a true lower high vs the peak (not the peak cluster)
    if (price >= peakPrice * 0.995) return
    const prev = byIndex.get(index)
    if (!prev || price > prev.price) {
      byIndex.set(index, {
        index,
        time: candles[index]!.time,
        price,
        kind: 'high',
      })
    }
  }

  for (const p of findSwingPoints(candles, lookback)) {
    if (p.kind === 'high') add(p.index)
  }

  // 1-bar local maxima
  for (let i = peakIdx + minSpan; i < last; i++) {
    const h = candles[i]!.high
    if (h >= candles[i - 1]!.high && h >= candles[i + 1]!.high) add(i)
  }

  // Segment maxima — highest candle in each slice of the post-peak range.
  // These are the "middle points on the highest candles".
  const span = last - peakIdx
  if (span >= minSpan * 2) {
    const segments = Math.max(3, Math.min(10, Math.floor(span / Math.max(minSpan, 4))))
    const segLen = Math.max(minSpan, Math.floor(span / segments))
    for (let s = 0; s < segments; s++) {
      const from = peakIdx + 1 + s * segLen
      const to = s === segments - 1 ? last : Math.min(last, from + segLen - 1)
      if (from > last) break
      let maxI = from
      let maxH = candles[from]!.high
      for (let i = from + 1; i <= to; i++) {
        if (candles[i]!.high > maxH) {
          maxH = candles[i]!.high
          maxI = i
        }
      }
      add(maxI)
    }
  }

  return [...byIndex.values()]
}

/** Max fraction any candle high pierces above the line. */
function maxPiercePct(
  candles: Candle[],
  startIdx: number,
  startPrice: number,
  slope: number,
  from: number,
  to: number,
): number {
  let max = 0
  for (let i = from; i <= to; i++) {
    const linePx = priceAt(startIdx, startPrice, slope, i)
    if (linePx <= 0) continue
    const pierce = (candles[i]!.high - linePx) / linePx
    if (pierce > max) max = pierce
  }
  return max
}

/** Swing highs that rest on the line (within tol). */
function swingTouches(
  swings: SwingPoint[],
  startIdx: number,
  startPrice: number,
  slope: number,
  tolPct: number,
): SwingPoint[] {
  const out: SwingPoint[] = []
  for (const s of swings) {
    if (s.index < startIdx) continue
    const linePx = priceAt(startIdx, startPrice, slope, s.index)
    if (linePx <= 0) continue
    if (Math.abs(s.price - linePx) / linePx <= tolPct) out.push(s)
  }
  return out
}

/**
 * Detect descending resistance trendlines from the absolute highest high.
 *
 * Start = peak high (correct).
 * Middle/second anchors must sit on the *highest* post-peak candles:
 * we try later highs from tallest → lowest, keep lines that no candle
 * pierces above, and score by how many other highs the line rests on.
 */
export function detectTrendlines(
  candles: Candle[],
  opts: TrendlineOptions = {},
): Trendline[] {
  const lookback = opts.lookback ?? 3
  const maxLines = opts.maxLines ?? 1
  const touchTolPct = opts.touchTolPct ?? 0.006
  const minSpan = opts.minSpan ?? 5

  if (candles.length < lookback * 2 + 10) return []

  const peakIdx = mostRecentHighestIndex(candles)
  if (peakIdx >= candles.length - minSpan - 1) return []

  const peakPrice = candles[peakIdx]!.high
  const peakTime = candles[peakIdx]!.time
  const last = candles.length - 1
  const close = candles[last]!.close

  const laterHighs = collectPostPeakHighs(candles, peakIdx, peakPrice, lookback, minSpan)
  if (!laterHighs.length) return []

  const peakSwing: SwingPoint = {
    index: peakIdx,
    time: peakTime,
    price: peakPrice,
    kind: 'high',
  }
  const allHighSwings = [peakSwing, ...laterHighs]

  type Cand = {
    i1: number
    p1: number
    slope: number
    touches: number
    score: number
    currentPrice: number
    touchSwings: SwingPoint[]
  }

  const candidates: Cand[] = []

  // Tallest post-peak candle highs first — middle points on the highest candles
  const byHeight = [...laterHighs].sort((a, b) => {
    if (b.price !== a.price) return b.price - a.price
    return a.index - b.index
  })

  for (const h of byHeight) {
    const slope = (h.price - peakPrice) / (h.index - peakIdx)
    // Descending (allow tiny flat noise)
    if (slope > peakPrice * 0.0002) continue

    const absPctPerBar = Math.abs(slope) / peakPrice
    if (absPctPerBar > 0.15) continue

    const currentPrice = priceAt(peakIdx, peakPrice, slope, last)
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue

    // Valid resistance along the defining segment (peak → second high):
    // no candle high meaningfully above the line. Later breaks are
    // reported via `broken`, not used to discard structure.
    const pierce = maxPiercePct(candles, peakIdx, peakPrice, slope, peakIdx, h.index)
    if (pierce > touchTolPct * 2) continue

    // After the anchor, allow price to test the line. Only reject if a
    // later swing high clearly breaks above (line is not structural resistance).
    let postSwingPierce = 0
    for (const s of laterHighs) {
      if (s.index <= h.index) continue
      const linePx = priceAt(peakIdx, peakPrice, slope, s.index)
      if (linePx <= 0) continue
      const pierce = (s.price - linePx) / linePx
      if (pierce > postSwingPierce) postSwingPierce = pierce
    }
    if (postSwingPierce > Math.max(0.025, touchTolPct * 4)) continue

    const touchSwings = swingTouches(
      allHighSwings,
      peakIdx,
      peakPrice,
      slope,
      touchTolPct,
    )
    // Peak + defining high should both be on the line; need ≥2
    if (touchSwings.length < 2) continue

    // How tightly the *tallest* other highs sit under the line.
    // Use only the top highs (by price) so mid-trend noise doesn't inflate the gap.
    const referenceHighs = [...laterHighs]
      .filter((s) => s.index !== h.index)
      .sort((a, b) => b.price - a.price)
      .slice(0, 6)
    let gapSum = 0
    let gapN = 0
    for (const s of referenceHighs) {
      const linePx = priceAt(peakIdx, peakPrice, slope, s.index)
      if (linePx <= 0) continue
      const gap = (linePx - s.price) / linePx
      if (gap < -touchTolPct) continue // above — already handled by pierce
      gapSum += gap
      gapN++
    }
    const avgGap = gapN ? gapSum / gapN : 0.5
    // Reject near-peak flat lines that float far above the other major highs
    if (avgGap > 0.18 && touchSwings.length < 3) continue

    // How many distinct highs the line rests on (middle points on highs)
    const touches = touchSwings.length
    const spanBars = h.index - peakIdx
    const spanBoost = Math.min(1.5, spanBars / 45)
    // Significance: taller second anchor = line rests on a more important high
    const heightRatio = h.price / peakPrice
    // Soft near-price preference only (structure first)
    const distPct = Math.abs(close - currentPrice) / Math.max(close, 1e-12)
    const proximity =
      distPct < 0.04 ? 1.12 : distPct < 0.1 ? 1.04 : distPct < 0.25 ? 1 : 0.88
    // Tighter fit to other highs (middle of line near candle highs)
    const tightBoost = 1 - Math.min(1, avgGap / 0.1)

    const score =
      // Primary: rest on as many highs as possible
      touches * 32 +
      // Prefer the tallest valid middle high (this is the key fix)
      heightRatio * 30 +
      // Prefer lines that hug other highs instead of floating above them
      tightBoost * 28 +
      spanBoost * 12 * proximity +
      // Slight bonus when projected level is still relevant
      (currentPrice > close * 0.7 && currentPrice < close * 1.35 ? 6 : 0)

    candidates.push({
      i1: h.index,
      p1: h.price,
      slope,
      touches,
      score,
      currentPrice,
      touchSwings,
    })
  }

  if (!candidates.length) return []

  candidates.sort((a, b) => b.score - a.score)

  const kept: Cand[] = []
  for (const c of candidates) {
    const dup = kept.some((k) => {
      const levelClose =
        Math.abs(k.currentPrice - c.currentPrice) / Math.max(c.currentPrice, 1e-12) < 0.008
      const slopeClose =
        Math.abs(k.slope - c.slope) / Math.max(Math.abs(c.slope), peakPrice * 1e-6) < 0.28
      return levelClose && slopeClose
    })
    if (!dup) kept.push(c)
  }

  return kept.slice(0, maxLines).map((c, n) => {
    const broken = close > c.currentPrice * (1 + touchTolPct)
    const distancePct = ((c.currentPrice - close) / close) * 100

    // Anchors = every high the line rests on (peak + middle highs + end)
    const anchors = c.touchSwings
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((s) => ({ time: s.time, price: s.price }))

    // Ensure defining endpoints are present even if tol excluded one
    const hasStart = anchors.some((a) => a.time === peakTime)
    const endTime = candles[c.i1]!.time
    const hasEnd = anchors.some((a) => a.time === endTime)
    if (!hasStart) anchors.unshift({ time: peakTime, price: peakPrice })
    if (!hasEnd) anchors.push({ time: endTime, price: c.p1 })

    return {
      id: `resistance-extreme-${peakIdx}-${c.i1}-${n}`,
      type: 'resistance' as const,
      method: 'extreme' as const,
      startIndex: peakIdx,
      endIndex: c.i1,
      startTime: peakTime,
      endTime,
      startPrice: peakPrice,
      endPrice: c.p1,
      slope: c.slope,
      currentPrice: c.currentPrice,
      distancePct,
      touches: c.touches,
      strength: Math.min(1, c.score / 130),
      broken,
      anchors,
    }
  })
}

/**
 * Sample a trendline as a straight geometric ray:
 * value = startPrice + slope * (barIndex - startIndex)
 */
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

  if (maxTotal === 1 && picked.length === 2) {
    const d0 = Math.abs(picked[0]!.price - price)
    const d1 = Math.abs(picked[1]!.price - price)
    return d0 <= d1 ? [picked[0]!] : [picked[1]!]
  }

  return picked.slice(0, maxTotal)
}
