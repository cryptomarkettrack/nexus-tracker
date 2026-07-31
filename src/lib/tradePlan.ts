import type {
  CoinMetrics,
  FundingInfo,
  MaLevel,
  TradePlan,
  TradeSide,
  Trendline,
  WatchZone,
} from './types'

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

  // MA stack bias: how many nearby MAs sit below (bullish cushion) vs above (overhead)
  let masBelow = 0
  let masAbove = 0
  for (const m of maLevels) {
    if (m.price <= price) masBelow++
    else masAbove++
  }

  let score = 0
  const reasons: string[] = []

  if (masBelow > masAbove) {
    score += 1.2
    reasons.push(`${masBelow} nearby MAs below price (cushion)`)
  } else if (masAbove > masBelow) {
    score -= 1.2
    reasons.push(`${masAbove} nearby MAs above price (overhead)`)
  }

  if (support && Math.abs(support.distancePct) < 1.2) {
    score += 1.5 + support.strength
    reasons.push(`Sitting on ${support.label} (${support.sources.slice(0, 2).join(', ')})`)
  } else if (support && Math.abs(support.distancePct) < 2.5) {
    score += 0.6
    reasons.push(`Support zone nearby @ ${absPct(support.distancePct)}`)
  }

  if (resistance && Math.abs(resistance.distancePct) < 1.2) {
    score -= 1.5 + resistance.strength
    reasons.push(`Pressing ${resistance.label} (${resistance.sources.slice(0, 2).join(', ')})`)
  } else if (resistance && Math.abs(resistance.distancePct) < 2.5) {
    score -= 0.6
    reasons.push(`Resistance nearby @ +${Math.abs(resistance.distancePct).toFixed(2)}%`)
  }

  if (rsi < 35) {
    score += 1
    reasons.push(`RSI ${rsi.toFixed(0)} oversold bias`)
  } else if (rsi > 68) {
    score -= 1
    reasons.push(`RSI ${rsi.toFixed(0)} overbought bias`)
  }

  if (metric?.setup === 'breakout' || metric?.setup === 'strength') {
    score += 1.2
    reasons.push(metric.setupReason)
  } else if (metric?.setup === 'weakness') {
    score -= 1.2
    reasons.push(metric.setupReason)
  } else if (metric?.setup === 'mean-reversion') {
    // lean toward fade of extremes
    if (rsi > 60) score -= 0.8
    else if (rsi < 40) score += 0.8
    reasons.push(metric.setupReason)
  } else if (metric?.setup === 'squeeze') {
    reasons.push('Compression — wait for expansion through zone')
  }

  if (funding) {
    if (funding.fundingRate > 0.0004) {
      score -= 0.5
      reasons.push('Crowded longs (elevated funding)')
    } else if (funding.fundingRate < -0.0001) {
      score += 0.5
      reasons.push('Crowded shorts (negative funding)')
    }
  }

  if (trendline && !trendline.broken && Math.abs(trendline.distancePct) < 2) {
    score -= 0.4
    reasons.push(`Peak TL nearby @ ${formatPx(trendline.currentPrice)}`)
  }

  let side: TradeSide
  let confidence: number
  if (score >= 1.2) {
    side = 'long'
    confidence = Math.min(92, 48 + score * 12)
  } else if (score <= -1.2) {
    side = 'short'
    confidence = Math.min(92, 48 + Math.abs(score) * 12)
  } else {
    side = 'flat'
    confidence = 30 + Math.abs(score) * 8
    reasons.push('No clean edge — wait for zone touch or break')
  }

  // Build levels for long/short (still useful when flat as a "if I had to" plan)
  const planSide: Exclude<TradeSide, 'flat'> = side === 'flat' ? (score >= 0 ? 'long' : 'short') : side

  let entry = price
  let stop: number
  let target1: number
  let target2: number
  let invalidation: string

  if (planSide === 'long') {
    // Prefer limit near support if close; else market
    if (support && Math.abs(support.distancePct) < 2) {
      entry = support.high // buy top of support band
      stop = support.low - atr * 0.35
      invalidation = `Close below support zone ${formatPx(support.low)}`
    } else {
      entry = price
      stop = price - atr * 1.15
      invalidation = `Close below ${formatPx(stop)} (~1.15 ATR)`
    }
    if (resistance) {
      target1 = resistance.low
      target2 = resistance.high + atr * 0.5
    } else {
      target1 = entry + atr
      target2 = entry + atr * 2
    }
    if (trendline && !trendline.broken && trendline.currentPrice > entry) {
      target1 = Math.min(target1, trendline.currentPrice)
    }
  } else {
    if (resistance && Math.abs(resistance.distancePct) < 2) {
      entry = resistance.low
      stop = resistance.high + atr * 0.35
      invalidation = `Close above resistance zone ${formatPx(resistance.high)}`
    } else {
      entry = price
      stop = price + atr * 1.15
      invalidation = `Close above ${formatPx(stop)} (~1.15 ATR)`
    }
    if (support) {
      target1 = support.high
      target2 = support.low - atr * 0.5
    } else {
      target1 = entry - atr
      target2 = entry - atr * 2
    }
  }

  const risk = Math.abs(entry - stop)
  const reward1 = Math.abs(target1 - entry)
  const reward2 = Math.abs(target2 - entry)
  const rr1 = risk > 0 ? reward1 / risk : 0
  const rr2 = risk > 0 ? reward2 / risk : 0

  // Trigger: when to actually open
  let trigger: string
  if (side === 'flat') {
    trigger = support
      ? `Wait for hold of ${formatPx(support.mid)} then long, or reject ${resistance ? formatPx(resistance.mid) : 'highs'} for short`
      : 'Wait for clearer zone interaction'
  } else if (planSide === 'long' && support && Math.abs(support.distancePct) > 0.8) {
    trigger = `Limit bid near ${formatPx(support.mid)} or market if reclaim holds`
  } else if (planSide === 'short' && resistance && Math.abs(resistance.distancePct) > 0.8) {
    trigger = `Limit offer near ${formatPx(resistance.mid)} or market on rejection wick`
  } else {
    trigger = 'Market-compatible — edge is present at spot'
  }

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
    reasons: reasons.slice(0, 5),
    trigger,
    invalidation,
    maBias: masBelow === masAbove ? 'mixed' : masBelow > masAbove ? 'bullish' : 'bearish',
    masBelow,
    masAbove,
  }
}

function absPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function formatPx(n: number): string {
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
  return n.toPrecision(4)
}

export function positionPnl(
  side: 'long' | 'short',
  entry: number,
  mark: number,
  sizeUsd: number,
): { pnlUsd: number; pnlPct: number } {
  const pnlPct = side === 'long' ? ((mark - entry) / entry) * 100 : ((entry - mark) / entry) * 100
  const pnlUsd = (pnlPct / 100) * sizeUsd
  return { pnlUsd, pnlPct }
}

export function rMultiple(
  side: 'long' | 'short',
  entry: number,
  stop: number,
  mark: number,
): number {
  const risk = Math.abs(entry - stop)
  if (risk <= 0) return 0
  const move = side === 'long' ? mark - entry : entry - mark
  return move / risk
}
