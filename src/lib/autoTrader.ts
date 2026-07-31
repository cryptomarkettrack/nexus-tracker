import type { Candle, Position, TradePlan } from './types'
import { positionPnl } from './tradePlan'

export type CloseReason = NonNullable<Position['closeReason']>

export const AUTO_MIN_CONFIDENCE = 55
/** Minutes after a close before auto may re-enter the same symbol */
export const AUTO_COOLDOWN_MIN = 20
/** Max auto backfill trades to inject when catching up */
export const AUTO_BACKFILL_LIMIT = 12

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

export function isAutoEnabled(autoSymbols: string[], symbol: string): boolean {
  return autoSymbols.includes(symbol)
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

export function inCooldown(
  positions: Position[],
  symbol: string,
  now = Date.now(),
  cooldownMin = AUTO_COOLDOWN_MIN,
): boolean {
  const last = lastCloseAt(positions, symbol)
  if (last == null) return false
  return now - last < cooldownMin * 60_000
}

/** Decide whether autopilot should open from the current trade plan. */
export function decideAutoOpen(
  plan: TradePlan | null | undefined,
  positions: Position[],
  opts?: { minConfidence?: number; now?: number },
): AutoOpenDecision {
  if (!plan) return { open: false }
  if (plan.side === 'flat') return { open: false, reason: 'flat bias' }
  const minConf = opts?.minConfidence ?? AUTO_MIN_CONFIDENCE
  if (plan.confidence < minConf) {
    return { open: false, reason: `confidence ${plan.confidence.toFixed(0)}% < ${minConf}%` }
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
  // Opposite side with conviction — exit at spot (caller supplies mark as price)
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
 * Lightweight historical sim so opening a coin shows how autopilot would have
 * performed over recent bars (RSI + close structure). Paper only.
 */
export function backfillAutoTrades(input: {
  symbol: string
  base: string
  candles: Candle[]
  sizeUsd: number
  /** Do not invent trades that overlap existing auto history */
  existing: Position[]
  limit?: number
}): Position[] {
  const { symbol, base, candles, sizeUsd, existing } = input
  const limit = input.limit ?? AUTO_BACKFILL_LIMIT
  if (candles.length < 30) return []

  const existingAuto = existing.filter((p) => p.symbol === symbol && p.source === 'auto')
  // Only backfill if we have almost no auto history for this symbol
  if (existingAuto.length >= 3) return []

  const closes = candles.map((c) => c.close)
  const trades: Position[] = []
  let open: Position | null = null
  let lastExitIdx = -999

  for (let i = 20; i < candles.length; i++) {
    const c = candles[i]!
    const rsi = rsiAt(closes, i, 14)
    const atr = atrAt(candles, i, 14)
    if (!atr || atr <= 0) continue

    if (open) {
      // exit on bar
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
      // force flat on last bar
      if (i === candles.length - 1) {
        trades.push(closeSim(open, c.close, c.time, 'manual'))
        open = null
      }
      continue
    }

    if (i - lastExitIdx < 3) continue
    if (trades.length >= limit) break

    // Entry heuristics mirroring desk bias (simplified)
    let side: 'long' | 'short' | null = null
    if (rsi < 35 && c.close > candles[i - 1]!.close) side = 'long'
    else if (rsi > 68 && c.close < candles[i - 1]!.close) side = 'short'
    else if (rsi < 40 && closes[i]! > smaAt(closes, i, 20)) side = 'long'
    else if (rsi > 60 && closes[i]! < smaAt(closes, i, 20)) side = 'short'

    if (!side) continue

    const entry = c.close
    const stop = side === 'long' ? entry - atr * 1.15 : entry + atr * 1.15
    const target1 = side === 'long' ? entry + atr : entry - atr
    const target2 = side === 'long' ? entry + atr * 2 : entry - atr * 2

    open = {
      id: `auto-bf-${symbol}-${c.time}`,
      symbol,
      base,
      side,
      entry,
      stop,
      target1,
      target2,
      sizeUsd,
      openedAt: c.time,
      note: `Backfill ${side} · RSI ${rsi.toFixed(0)}`,
      status: 'open',
      source: 'auto',
    }
  }

  // Keep closed only (drop dangling open from sim — live engine will re-decide)
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
