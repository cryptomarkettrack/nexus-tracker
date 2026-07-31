import type { Interval, Position } from './types'
import { positionPnl } from './tradePlan'

export type AuditAction = 'open' | 'close'

export interface AuditEvent {
  id: string
  action: AuditAction
  at: number
  positionId: string
  symbol: string
  base: string
  side: 'long' | 'short'
  source: 'manual' | 'auto'
  /** Entry for open; exit for close */
  price: number
  entry: number
  sizeUsd: number
  note?: string
  /** Full open rationale (drivers + trigger) */
  openReason?: string
  interval?: Interval
  closeReason?: Position['closeReason']
  /** Realized (close) or unrealized (open, if mark provided) */
  pnlUsd?: number
  pnlPct?: number
  /** Hold duration in ms (close only) */
  heldMs?: number
  status: Position['status']
}

export function buildAuditLog(
  positions: Position[],
  opts?: {
    symbol?: string
    markBySymbol?: Map<string, number> | Record<string, number>
    limit?: number
  },
): AuditEvent[] {
  const limit = opts?.limit ?? 80
  const symbol = opts?.symbol
  const list = symbol ? positions.filter((p) => p.symbol === symbol) : positions
  const events: AuditEvent[] = []

  for (const p of list) {
    const source = p.source ?? 'manual'
    const openReason = p.openReason || p.note || undefined

    events.push({
      id: `${p.id}-open`,
      action: 'open',
      at: p.openedAt,
      positionId: p.id,
      symbol: p.symbol,
      base: p.base,
      side: p.side,
      source,
      price: p.entry,
      entry: p.entry,
      sizeUsd: p.sizeUsd,
      note: p.note,
      openReason,
      interval: p.interval,
      status: p.status,
    })

    if (p.status === 'closed' && p.closedAt != null && p.closePrice != null) {
      const { pnlUsd, pnlPct } = positionPnl(p.side, p.entry, p.closePrice, p.sizeUsd)
      events.push({
        id: `${p.id}-close`,
        action: 'close',
        at: p.closedAt,
        positionId: p.id,
        symbol: p.symbol,
        base: p.base,
        side: p.side,
        source,
        price: p.closePrice,
        entry: p.entry,
        sizeUsd: p.sizeUsd,
        note: p.note,
        openReason,
        interval: p.interval,
        closeReason: p.closeReason,
        pnlUsd: p.realizedPnlUsd ?? pnlUsd,
        pnlPct,
        heldMs: Math.max(0, p.closedAt - p.openedAt),
        status: 'closed',
      })
    } else if (p.status === 'open' && opts?.markBySymbol) {
      const mark = getMark(opts.markBySymbol, p.symbol)
      if (mark != null && mark > 0) {
        const { pnlUsd, pnlPct } = positionPnl(p.side, p.entry, mark, p.sizeUsd)
        const openEv = events[events.length - 1]!
        openEv.pnlUsd = pnlUsd
        openEv.pnlPct = pnlPct
      }
    }
  }

  events.sort((a, b) => b.at - a.at || (a.action === 'close' ? -1 : 1))
  return events.slice(0, limit)
}

function getMark(
  marks: Map<string, number> | Record<string, number>,
  symbol: string,
): number | undefined {
  if (marks instanceof Map) return marks.get(symbol)
  return marks[symbol]
}

export function formatAuditTime(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function formatHeld(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ${sec % 60}s`
  const hr = Math.floor(min / 60)
  if (hr < 48) return `${hr}h ${min % 60}m`
  const days = Math.floor(hr / 24)
  return `${days}d ${hr % 24}h`
}

export function closeReasonLabel(reason: Position['closeReason'] | undefined): string {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'target1':
      return 'T1'
    case 'target2':
      return 'T2'
    case 'flip':
      return 'bias flip'
    case 'manual':
      return 'manual'
    case 'reconcile':
      return 'reconcile'
    default:
      return 'exit'
  }
}

/** Readable open description for audit / position cards */
export function formatOpenReason(ev: Pick<AuditEvent, 'action' | 'openReason' | 'note' | 'closeReason'>): string {
  if (ev.action === 'open') {
    return ev.openReason || ev.note || 'No reason recorded'
  }
  const exit = closeReasonLabel(ev.closeReason)
  if (ev.openReason) return `Exit: ${exit}. Opened because: ${ev.openReason}`
  if (ev.note) return `Exit: ${exit}. ${ev.note}`
  return `Exit: ${exit}`
}
