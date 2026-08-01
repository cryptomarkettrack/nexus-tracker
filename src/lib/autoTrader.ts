import type { AutoBinding, Candle, Interval, Position, TradePlan } from './types'
import { MIN_RR1, positionPnl, sanitizeTradeLevels } from './tradePlan'

export type CloseReason = NonNullable<Position['closeReason']>

/** Higher bar: only open when plan has real multi-factor conviction */
export const AUTO_MIN_CONFIDENCE = 68
/** Paper notional used for every autopilot open */
export const AUTO_SIZE_USD = 10_000
/** Minutes after a close before auto may re-enter the same symbol */
export const AUTO_COOLDOWN_MIN = 30
/** Extra cooldown after a stop-out (avoid revenge re-entries) */
export const AUTO_LOSS_COOLDOWN_MIN = 55
/** Max auto backfill trades to inject when catching up */
export const AUTO_BACKFILL_LIMIT = 8
/** Minimum R:R for autopilot opens */
export const AUTO_MIN_RR = MIN_RR1

export interface AutoOpenDecision {
  open: boolean
  side?: 'long' | 'short'
  reason?: string
}

export interface AutoExitDecision {
  exit: boolean
  price: number
  reason: CloseReason
  at?: number
}

export interface AutoPerf {
  symbol: string
  openCount: number
  closedCount: number
  wins: number
  losses: number
  realizedUsd: number
  unrealizedUsd: number
  totalUsd: number
  winRate: number
  lastClosedAt: number | null
  /** Closed since `sinceMs` (e.g. while away) */
  awayRealizedUsd: number
  awayClosedCount: number
}

export function isAutoEnabled(
  autoBindings: AutoBinding[] | string[],
  symbol: string,
): boolean {
  if (!autoBindings.length) return false
  if (typeof autoBindings[0] === 'string') {
    return (autoBindings as string[]).includes(symbol)
  }
  return (autoBindings as AutoBinding[]).some((b) => b.symbol === symbol)
}

export function getAutoInterval(
  autoBindings: AutoBinding[],
  symbol: string,
): Interval | null {
  return autoBindings.find((b) => b.symbol === symbol)?.interval ?? null
}

/** Autopilot only acts on the timeframe locked when the user enabled it */
export function isAutoActiveOnInterval(
  autoBindings: AutoBinding[],
  symbol: string,
  interval: Interval,
): boolean {
  const locked = getAutoInterval(autoBindings, symbol)
  return locked != null && locked === interval
}

export function hasOpenPosition(positions: Position[], symbol: string): boolean {
  return positions.some((p) => p.status === 'open' && p.symbol === symbol)
}

export function lastCloseAt(positions: Position[], symbol: string): number | null {
  let max: number | null = null
  for (const p of positions) {
    if (p.symbol !== symbol || p.status !== 'closed' || !p.closedAt) continue
    if (max == null || p.closedAt > max) max = p.closedAt
  }
  return max
}

function lastCloseMeta(
  positions: Position[],
  symbol: string,
): { at: number; wasLoss: boolean } | null {
  let best: Position | null = null
  for (const p of positions) {
    if (p.symbol !== symbol || p.status !== 'closed' || !p.closedAt) continue
    if (!best || (best.closedAt ?? 0) < p.closedAt) best = p
  }
  if (!best?.closedAt) return null
  const pnl = best.realizedPnlUsd ?? 0
  return { at: best.closedAt, wasLoss: pnl < 0 }
}

export function inCooldown(
  positions: Position[],
  symbol: string,
  now = Date.now(),
  cooldownMin = AUTO_COOLDOWN_MIN,
): boolean {
  const meta = lastCloseMeta(positions, symbol)
  if (!meta) return false
  const mins = meta.wasLoss ? AUTO_LOSS_COOLDOWN_MIN : cooldownMin
  return now - meta.at < mins * 60_000
}

/** Decide whether autopilot should open from the current trade plan. */
export function decideAutoOpen(
  plan: TradePlan | null | undefined,
  positions: Position[],
  opts?: { minConfidence?: number; minRr?: number; now?: number },
): AutoOpenDecision {
  if (!plan) return { open: false }
  if (plan.side === 'flat') return { open: false, reason: 'flat bias' }
  const minConf = opts?.minConfidence ?? AUTO_MIN_CONFIDENCE
  const minRr = opts?.minRr ?? AUTO_MIN_RR
  if (plan.confidence < minConf) {
    return { open: false, reason: `confidence ${plan.confidence.toFixed(0)}% < ${minConf}%` }
  }
  if (plan.rr1 < minRr) {
    return { open: false, reason: `R:R ${plan.rr1.toFixed(2)} < ${minRr}` }
  }
  // planSide must match directional side (never open the "if I had to" opposite)
  if (plan.side !== plan.planSide) {
    return { open: false, reason: 'side/planSide mismatch' }
  }
  if (hasOpenPosition(positions, plan.symbol)) {
    return { open: false, reason: 'already in position' }
  }
  if (inCooldown(positions, plan.symbol, opts?.now)) {
    return { open: false, reason: 'cooldown after last exit' }
  }
  return {
    open: true,
    side: plan.planSide,
    reason: plan.reasons[0] ?? plan.trigger,
  }
}

/**
 * Whether the live mark is close enough to the plan entry to take the auto fill.
 * Avoids chasing when the desk wants a limit near a zone.
 */
export function entryIsReachable(
  plan: TradePlan,
  mark: number,
  maxDriftAtr = 0.35,
): boolean {
  if (!mark || mark <= 0 || !plan.atr) return false
  const drift = Math.abs(mark - plan.entry)
  // Market-compatible triggers: allow fill at spot
  if (plan.trigger.startsWith('Market-compatible')) return drift <= plan.atr * 0.6
  // Limit-style: only if mark is near the planned entry (or better)
  if (plan.side === 'long') {
    // Willing to buy at or below plan entry (+ small slip)
    return mark <= plan.entry + plan.atr * maxDriftAtr
  }
  if (plan.side === 'short') {
    return mark >= plan.entry - plan.atr * maxDriftAtr
  }
  return false
}

/** Live mark-to-market exit (stop or T1). Conservative: stop wins if both would fire. */
export function decideLiveExit(pos: Position, mark: number): AutoExitDecision | null {
  if (pos.status !== 'open' || !Number.isFinite(mark) || mark <= 0) return null

  if (pos.side === 'long') {
    if (mark <= pos.stop) return { exit: true, price: pos.stop, reason: 'stop' }
    if (mark >= pos.target1) return { exit: true, price: pos.target1, reason: 'target1' }
  } else {
    if (mark >= pos.stop) return { exit: true, price: pos.stop, reason: 'stop' }
    if (mark <= pos.target1) return { exit: true, price: pos.target1, reason: 'target1' }
  }
  return null
}

/** Bias flip: strong plan against open auto position. */
export function decideFlipExit(
  pos: Position,
  plan: TradePlan | null | undefined,
  minConfidence = AUTO_MIN_CONFIDENCE,
): AutoExitDecision | null {
  if (!plan || pos.status !== 'open' || pos.source !== 'auto') return null
  if (plan.confidence < minConfidence) return null
  if (plan.side === 'flat') return null
  if (plan.side === pos.side) return null
  // Require real opposite edge + R:R so we don't flip on noise
  if (plan.rr1 < AUTO_MIN_RR) return null
  return { exit: true, price: 0, reason: 'flip' }
}

/**
 * Walk candles after open to find first stop/target hit while offline.
 * Same-bar ambiguity: stop first (conservative).
 */
export function decideCandleExit(
  pos: Position,
  candles: Candle[],
): AutoExitDecision | null {
  if (pos.status !== 'open' || !candles.length) return null
  const openedAt = pos.openedAt

  for (const c of candles) {
    // candle.time is open time; allow bar that contains open or later
    if (c.time + 60_000 < openedAt) continue

    if (pos.side === 'long') {
      if (c.low <= pos.stop) {
        return { exit: true, price: pos.stop, reason: 'reconcile', at: c.time }
      }
      if (c.high >= pos.target1) {
        return { exit: true, price: pos.target1, reason: 'target1', at: c.time }
      }
    } else {
      if (c.high >= pos.stop) {
        return { exit: true, price: pos.stop, reason: 'reconcile', at: c.time }
      }
      if (c.low <= pos.target1) {
        return { exit: true, price: pos.target1, reason: 'target1', at: c.time }
      }
    }
  }
  return null
}

/**
 * Historical sim aligned with live filters: RSI extremes only with
 * bounce/rejection confirmation and min R:R geometry.
 */
export function backfillAutoTrades(input: {
  symbol: string
  base: string
  candles: Candle[]
  sizeUsd: number
  interval: Interval
  /** Do not invent trades that overlap existing auto history */
  existing: Position[]
  limit?: number
}): Position[] {
  const { symbol, base, candles, sizeUsd, interval, existing } = input
  const limit = input.limit ?? AUTO_BACKFILL_LIMIT
  if (candles.length < 40) return []

  const existingAuto = existing.filter(
    (p) =>
      p.symbol === symbol &&
      p.source === 'auto' &&
      (p.interval == null || p.interval === interval),
  )
  // Only backfill if we have almost no auto history for this symbol+TF
  if (existingAuto.length >= 3) return []

  const closes = candles.map((c) => c.close)
  const trades: Position[] = []
  let open: Position | null = null
  let lastExitIdx = -999

  for (let i = 30; i < candles.length; i++) {
    const c = candles[i]!
    const prev = candles[i - 1]!
    const rsi = rsiAt(closes, i, 14)
    const atr = atrAt(candles, i, 14)
    const sma20 = smaAt(closes, i, 20)
    const sma50 = i >= 50 ? smaAt(closes, i, 50) : sma20
    if (!atr || atr <= 0) continue

    if (open) {
      if (open.side === 'long') {
        if (c.low <= open.stop) {
          trades.push(closeSim(open, open.stop, c.time, 'stop'))
          open = null
          lastExitIdx = i
          continue
        }
        if (c.high >= open.target1) {
          trades.push(closeSim(open, open.target1, c.time, 'target1'))
          open = null
          lastExitIdx = i
          continue
        }
      } else {
        if (c.high >= open.stop) {
          trades.push(closeSim(open, open.stop, c.time, 'stop'))
          open = null
          lastExitIdx = i
          continue
        }
        if (c.low <= open.target1) {
          trades.push(closeSim(open, open.target1, c.time, 'target1'))
          open = null
          lastExitIdx = i
          continue
        }
      }
      if (i === candles.length - 1) {
        trades.push(closeSim(open, c.close, c.time, 'manual'))
        open = null
      }
      continue
    }

    // Wider spacing after exits (was 3 bars)
    if (i - lastExitIdx < 5) continue
    if (trades.length >= limit) break

    // Stricter entries: extreme RSI + confirmation candle + trend alignment
    let side: 'long' | 'short' | null = null
    const bullBar = c.close > c.open && c.close > prev.close
    const bearBar = c.close < c.open && c.close < prev.close
    const aboveSma = c.close > sma20 && sma20 >= sma50 * 0.998
    const belowSma = c.close < sma20 && sma20 <= sma50 * 1.002

    // Long: oversold bounce — require bullish reclaim, not catch a falling knife
    if (rsi < 32 && bullBar && c.close > sma20) side = 'long'
    // Short: overbought rejection — require bearish fail
    else if (rsi > 68 && bearBar && c.close < sma20) side = 'short'
    // Mild trend continuation only with momentum alignment
    else if (rsi >= 40 && rsi <= 55 && bullBar && aboveSma && c.close > prev.high) side = 'long'
    else if (rsi >= 45 && rsi <= 60 && bearBar && belowSma && c.close < prev.low) side = 'short'

    if (!side) continue

    const entry = c.close
    let stop = side === 'long' ? entry - atr * 1.15 : entry + atr * 1.15
    let target1 = side === 'long' ? entry + atr * 1.75 : entry - atr * 1.75
    let target2 = side === 'long' ? entry + atr * 2.6 : entry - atr * 2.6
    const clean = sanitizeTradeLevels(side, entry, stop, target1, target2, atr)
    stop = clean.stop
    target1 = clean.target1
    target2 = clean.target2

    const risk = Math.abs(entry - stop)
    const reward = Math.abs(target1 - entry)
    if (risk <= 0 || reward / risk < AUTO_MIN_RR) continue

    const openReason =
      `Backfill ${side.toUpperCase()} on ${interval} · RSI ${rsi.toFixed(0)} · ` +
      `confirmed ${side === 'long' ? 'reclaim' : 'rejection'} · R${(reward / risk).toFixed(1)}`
    open = {
      id: `auto-bf-${symbol}-${interval}-${c.time}`,
      symbol,
      base,
      side,
      entry,
      stop,
      target1,
      target2,
      sizeUsd,
      openedAt: c.time,
      note: openReason,
      openReason,
      interval,
      status: 'open',
      source: 'auto',
    }
  }

  return trades.filter((t) => t.status === 'closed').slice(-limit)
}

function closeSim(
  open: Position,
  price: number,
  at: number,
  reason: CloseReason,
): Position {
  const { pnlUsd } = positionPnl(open.side, open.entry, price, open.sizeUsd)
  return {
    ...open,
    status: 'closed',
    closedAt: at,
    closePrice: price,
    realizedPnlUsd: pnlUsd,
    closeReason: reason,
  }
}

export function summarizeAutoPerf(
  positions: Position[],
  symbol: string,
  mark: number | null | undefined,
  awaySinceMs?: number,
): AutoPerf {
  const auto = positions.filter((p) => p.symbol === symbol && p.source === 'auto')
  const open = auto.filter((p) => p.status === 'open')
  const closed = auto.filter((p) => p.status === 'closed')

  let realizedUsd = 0
  let wins = 0
  let losses = 0
  let lastClosedAt: number | null = null
  let awayRealizedUsd = 0
  let awayClosedCount = 0
  const since = awaySinceMs ?? 0

  for (const p of closed) {
    const r = p.realizedPnlUsd ?? 0
    realizedUsd += r
    if (r >= 0) wins++
    else losses++
    if (p.closedAt != null && (lastClosedAt == null || p.closedAt > lastClosedAt)) {
      lastClosedAt = p.closedAt
    }
    if (p.closedAt != null && p.closedAt >= since) {
      awayRealizedUsd += r
      awayClosedCount++
    }
  }

  let unrealizedUsd = 0
  if (mark != null && mark > 0) {
    for (const p of open) {
      unrealizedUsd += positionPnl(p.side, p.entry, mark, p.sizeUsd).pnlUsd
    }
  }

  const closedCount = closed.length
  return {
    symbol,
    openCount: open.length,
    closedCount,
    wins,
    losses,
    realizedUsd,
    unrealizedUsd,
    totalUsd: realizedUsd + unrealizedUsd,
    winRate: closedCount ? (wins / closedCount) * 100 : 0,
    lastClosedAt,
    awayRealizedUsd,
    awayClosedCount,
  }
}

function rsiAt(closes: number[], i: number, period: number): number {
  if (i < period) return 50
  let gains = 0
  let losses = 0
  for (let k = i - period + 1; k <= i; k++) {
    const d = closes[k]! - closes[k - 1]!
    if (d >= 0) gains += d
    else losses -= d
  }
  if (losses === 0) return 100
  const rs = gains / losses
  return 100 - 100 / (1 + rs)
}

function smaAt(closes: number[], i: number, period: number): number {
  let s = 0
  for (let k = i - period + 1; k <= i; k++) s += closes[k]!
  return s / period
}

function atrAt(candles: Candle[], i: number, period: number): number {
  if (i < 1) return 0
  const start = Math.max(1, i - period + 1)
  let sum = 0
  let n = 0
  for (let k = start; k <= i; k++) {
    const c = candles[k]!
    const prev = candles[k - 1]!
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close))
    sum += tr
    n++
  }
  return n ? sum / n : 0
}
