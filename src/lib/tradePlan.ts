import type {
  CoinMetrics,
  FundingInfo,
  MaLevel,
  TradePlan,
  TradeSide,
  Trendline,
  WatchZone,
} from './types'

/** Minimum reward:risk for a plan to be tradeable (auto + desk quality). */
export const MIN_RR1 = 1.5
/** Score magnitude required for a non-flat directional bias. */
export const MIN_EDGE_SCORE = 1.8

export function buildTradePlan(input: {
  symbol: string
  base: string
  price: number
  zones: WatchZone[]
  maLevels: MaLevel[]
  metric?: CoinMetrics
  funding?: FundingInfo
  trendline?: Trendline
}): TradePlan | null {
  const { symbol, base, price, zones, maLevels, metric, funding, trendline } = input
  if (!price || !Number.isFinite(price)) return null

  const support = zones.find((z) => z.side === 'below')
  const resistance = zones.find((z) => z.side === 'above')
  const atr = metric?.atr && metric.atr > 0 ? metric.atr : price * 0.015
  const rsi = metric?.rsi ?? 50
  const nearSup = support != null && Math.abs(support.distancePct) < 1.2
  const midSup = support != null && Math.abs(support.distancePct) < 2.5
  const nearRes = resistance != null && Math.abs(resistance.distancePct) < 1.2
  const midRes = resistance != null && Math.abs(resistance.distancePct) < 2.5

  // MA stack: soft context only (capped) so it cannot overpower structure + RSI
  let masBelow = 0
  let masAbove = 0
  for (const m of maLevels) {
    if (m.price <= price) masBelow++
    else masAbove++
  }
  const maDelta = masBelow - masAbove

  let score = 0
  const reasons: string[] = []

  // --- Structure (primary) ---
  if (nearSup && support) {
    score += 1.6 + support.strength * 0.8
    reasons.push(`Sitting on ${support.label} (${support.sources.slice(0, 2).join(', ')})`)
  } else if (midSup && support) {
    score += 0.5
    reasons.push(`Support zone nearby @ ${absPct(support.distancePct)}`)
  }

  if (nearRes && resistance) {
    score -= 1.6 + resistance.strength * 0.8
    reasons.push(`Pressing ${resistance.label} (${resistance.sources.slice(0, 2).join(', ')})`)
  } else if (midRes && resistance) {
    score -= 0.5
    reasons.push(`Resistance nearby @ +${Math.abs(resistance.distancePct).toFixed(2)}%`)
  }

  // --- RSI (align with structure; extremes need the zone) ---
  if (rsi < 30) {
    score += nearSup ? 1.4 : 0.35
    reasons.push(`RSI ${rsi.toFixed(0)} oversold${nearSup ? ' at support' : ''}`)
  } else if (rsi < 40) {
    score += nearSup ? 0.8 : 0.15
    reasons.push(`RSI ${rsi.toFixed(0)} soft oversold`)
  } else if (rsi > 70) {
    score -= nearRes ? 1.4 : 0.35
    reasons.push(`RSI ${rsi.toFixed(0)} overbought${nearRes ? ' at resistance' : ''}`)
  } else if (rsi > 60) {
    score -= nearRes ? 0.8 : 0.15
    reasons.push(`RSI ${rsi.toFixed(0)} soft overbought`)
  }

  // --- MA context (capped ±0.7) ---
  if (maDelta >= 2) {
    const bump = Math.min(0.7, 0.25 * maDelta)
    score += bump
    reasons.push(`${masBelow} nearby MAs below price (cushion)`)
  } else if (maDelta <= -2) {
    const bump = Math.min(0.7, 0.25 * Math.abs(maDelta))
    score -= bump
    reasons.push(`${masAbove} nearby MAs above price (overhead)`)
  }

  // --- Setup tags ---
  if (metric?.setup === 'breakout' || metric?.setup === 'strength') {
    score += 1.0
    reasons.push(metric.setupReason)
  } else if (metric?.setup === 'weakness') {
    score -= 1.0
    reasons.push(metric.setupReason)
  } else if (metric?.setup === 'mean-reversion') {
    if (rsi > 65 && (nearRes || midRes)) score -= 0.9
    else if (rsi < 35 && (nearSup || midSup)) score += 0.9
    else score += rsi < 50 ? 0.2 : -0.2
    reasons.push(metric.setupReason)
  } else if (metric?.setup === 'squeeze') {
    // Compression is not an edge by itself — wait for expansion
    score *= 0.5
    reasons.push('Compression — wait for expansion through zone')
  }

  if (funding) {
    if (funding.fundingRate > 0.0004) {
      score -= 0.35
      reasons.push('Crowded longs (elevated funding)')
    } else if (funding.fundingRate < -0.0001) {
      score += 0.35
      reasons.push('Crowded shorts (negative funding)')
    }
  }

  if (trendline && !trendline.broken && Math.abs(trendline.distancePct) < 1.5) {
    // Peak TL above = resistance for longs; below = support for shorts
    if (trendline.currentPrice > price) {
      score -= 0.35
      reasons.push(`Peak TL overhead @ ${formatPx(trendline.currentPrice)}`)
    } else {
      score += 0.35
      reasons.push(`Peak TL support @ ${formatPx(trendline.currentPrice)}`)
    }
  }

  // Momentum soft filter: don't fade a strong trend bar without a zone
  const chg = metric?.change24h ?? 0
  if (chg > 3 && !nearRes) score += 0.3
  if (chg < -3 && !nearSup) score -= 0.3

  let side: TradeSide
  let confidence: number
  if (score >= MIN_EDGE_SCORE) {
    side = 'long'
    confidence = Math.min(90, 50 + score * 10)
  } else if (score <= -MIN_EDGE_SCORE) {
    side = 'short'
    confidence = Math.min(90, 50 + Math.abs(score) * 10)
  } else {
    side = 'flat'
    confidence = 28 + Math.abs(score) * 6
    reasons.push('No clean edge — wait for aligned zone + RSI')
  }

  // --- Hard quality gates (biggest win-rate levers) ---
  // Never short into support while oversold (classic trap in the trade log)
  if (side === 'short' && nearSup && rsi < 42) {
    side = 'flat'
    confidence = Math.min(confidence, 35)
    reasons.push('Blocked short into support while RSI soft/oversold')
  }
  // Never long into resistance while overbought
  if (side === 'long' && nearRes && rsi > 58) {
    side = 'flat'
    confidence = Math.min(confidence, 35)
    reasons.push('Blocked long into resistance while RSI soft/overbought')
  }
  // Don't short a naked free-fall without resistance structure
  if (side === 'short' && !nearRes && !midRes && rsi < 35) {
    side = 'flat'
    confidence = Math.min(confidence, 32)
    reasons.push('Blocked knife-catch short — no resistance to fade from')
  }
  // Don't long a naked melt-up without support structure
  if (side === 'long' && !nearSup && !midSup && rsi > 65) {
    side = 'flat'
    confidence = Math.min(confidence, 32)
    reasons.push('Blocked chase long — no support to buy from')
  }
  // Require structural anchor for directional auto-quality
  if (side === 'long' && !nearSup && !midSup && maDelta < 2) {
    side = 'flat'
    confidence = Math.min(confidence, 38)
    reasons.push('Long needs support touch or MA cushion')
  }
  if (side === 'short' && !nearRes && !midRes && maDelta > -2) {
    side = 'flat'
    confidence = Math.min(confidence, 38)
    reasons.push('Short needs resistance touch or MA overhead')
  }

  const planSide: Exclude<TradeSide, 'flat'> =
    side === 'flat' ? (score >= 0 ? 'long' : 'short') : side

  let entry = price
  let stop: number
  let target1: number
  let target2: number
  let invalidation: string

  if (planSide === 'long') {
    if (support && Math.abs(support.distancePct) < 2.2) {
      entry = clamp(support.high, price * 0.995, price * 1.002)
      stop = support.low - atr * 0.4
      invalidation = `Close below support zone ${formatPx(support.low)}`
    } else {
      entry = price
      stop = price - atr * 1.2
      invalidation = `Close below ${formatPx(stop)} (~1.2 ATR)`
    }
    if (resistance && resistance.low > entry) {
      target1 = resistance.low
      target2 = resistance.high + atr * 0.45
    } else {
      target1 = entry + atr * 1.6
      target2 = entry + atr * 2.6
    }
    if (trendline && !trendline.broken && trendline.currentPrice > entry) {
      // Cap target at TL only if it still clears min RR after sanitize
      const tlCap = trendline.currentPrice
      if (tlCap > entry) target1 = Math.min(target1, tlCap)
    }
  } else {
    if (resistance && Math.abs(resistance.distancePct) < 2.2) {
      entry = clamp(resistance.low, price * 0.998, price * 1.005)
      stop = resistance.high + atr * 0.4
      invalidation = `Close above resistance zone ${formatPx(resistance.high)}`
    } else {
      entry = price
      stop = price + atr * 1.2
      invalidation = `Close above ${formatPx(stop)} (~1.2 ATR)`
    }
    if (support && support.high < entry) {
      target1 = support.high
      target2 = support.low - atr * 0.45
    } else {
      target1 = entry - atr * 1.6
      target2 = entry - atr * 2.6
    }
  }

  // Geometry safety + min R:R (expands target / trims stop when needed)
  const sanitized = sanitizeTradeLevels(planSide, entry, stop, target1, target2, atr)
  entry = sanitized.entry
  stop = sanitized.stop
  target1 = sanitized.target1
  target2 = sanitized.target2

  const risk = Math.abs(entry - stop)
  const reward1 = Math.abs(target1 - entry)
  const reward2 = Math.abs(target2 - entry)
  const rr1 = risk > 0 ? reward1 / risk : 0
  const rr2 = risk > 0 ? reward2 / risk : 0

  // Poor R:R is not a trade — demote to flat for autopilot quality
  if (side !== 'flat' && rr1 < MIN_RR1) {
    side = 'flat'
    confidence = Math.min(confidence, 36)
    reasons.push(`Blocked: R:R ${rr1.toFixed(2)} < ${MIN_RR1}`)
  } else if (side !== 'flat' && rr1 >= MIN_RR1) {
    // Reward clean asymmetric setups
    confidence = Math.min(92, confidence + Math.min(8, (rr1 - MIN_RR1) * 4))
  }

  let trigger: string
  if (side === 'flat') {
    trigger = support
      ? `Wait for hold of ${formatPx(support.mid)} then long, or reject ${resistance ? formatPx(resistance.mid) : 'highs'} for short`
      : 'Wait for clearer zone interaction'
  } else if (planSide === 'long' && support && Math.abs(support.distancePct) > 0.6) {
    trigger = `Limit bid near ${formatPx(support.mid)} or market if reclaim holds`
  } else if (planSide === 'short' && resistance && Math.abs(resistance.distancePct) > 0.6) {
    trigger = `Limit offer near ${formatPx(resistance.mid)} or market on rejection wick`
  } else {
    trigger = 'Market-compatible — edge is present at spot'
  }

  // Prefer reasons that explain the active bias first (cleaner desk / auto notes)
  const ordered = prioritizeReasons(reasons, side === 'flat' ? planSide : side)

  return {
    symbol,
    base,
    side,
    planSide,
    confidence,
    entry,
    stop,
    target1,
    target2,
    riskPct: (risk / entry) * 100,
    rr1,
    rr2,
    atr,
    reasons: ordered.slice(0, 6),
    trigger,
    invalidation,
    maBias: masBelow === masAbove ? 'mixed' : masBelow > masAbove ? 'bullish' : 'bearish',
    masBelow,
    masAbove,
  }
}

function prioritizeReasons(reasons: string[], bias: 'long' | 'short'): string[] {
  const longKeys = [/support/i, /oversold/i, /cushion/i, /breakout/i, /strength/i, /reclaim/i]
  const shortKeys = [/resistance/i, /overbought/i, /overhead/i, /weakness/i, /reject/i]
  const keys = bias === 'long' ? longKeys : shortKeys
  const score = (r: string) => {
    if (/^Blocked/i.test(r)) return 100
    const idx = keys.findIndex((k) => k.test(r))
    return idx === -1 ? 50 : idx
  }
  return [...reasons].sort((a, b) => score(a) - score(b))
}

/**
 * Ensure stop/targets sit on the correct side of entry and T1 clears MIN_RR1.
 */
export function sanitizeTradeLevels(
  side: 'long' | 'short',
  entry: number,
  stop: number,
  target1: number,
  target2: number,
  atr: number,
): { entry: number; stop: number; target1: number; target2: number } {
  const minRisk = Math.max(atr * 0.55, entry * 0.0015)
  let s = stop
  let t1 = target1
  let t2 = target2

  if (side === 'long') {
    if (!(s < entry)) s = entry - minRisk
    // Floor risk so noise doesn't nuke the stop
    if (entry - s < minRisk) s = entry - minRisk
    // Cap risk at ~2.2 ATR so RR stays attainable
    if (entry - s > atr * 2.2) s = entry - atr * 2.2
    const risk = entry - s
    const minReward = risk * MIN_RR1
    if (!(t1 > entry) || t1 - entry < minReward) t1 = entry + minReward
    if (!(t2 > t1)) t2 = t1 + risk * 0.8
  } else {
    if (!(s > entry)) s = entry + minRisk
    if (s - entry < minRisk) s = entry + minRisk
    if (s - entry > atr * 2.2) s = entry + atr * 2.2
    const risk = s - entry
    const minReward = risk * MIN_RR1
    if (!(t1 < entry) || entry - t1 < minReward) t1 = entry - minReward
    if (!(t2 < t1)) t2 = t1 - risk * 0.8
  }

  return { entry, stop: s, target1: t1, target2: t2 }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function absPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function formatPx(n: number): string {
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
  return n.toPrecision(4)
}
