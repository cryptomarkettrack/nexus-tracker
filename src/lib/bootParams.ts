import type { Interval, Mode } from './types'

const MODES: Mode[] = ['command', 'scanner', 'radar', 'focus']
const INTERVALS: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w']

export interface BootParams {
  mode?: Mode
  symbol?: string
  interval?: Interval
  /** Clean layout for Telegram / headless screenshots */
  snapshot: boolean
  /**
   * How many recent candles to show in the chart viewport.
   * Full history is still loaded for S/R / zone detection — this only controls zoom.
   * Snapshot mode defaults to SNAPSHOT_VISIBLE_BARS when unset.
   */
  visibleBars?: number
}

/** Default zoom window for Telegram / snapshot captures (keeps S/R from full history). */
export const SNAPSHOT_VISIBLE_BARS = 90

function isMode(v: string | null): v is Mode {
  return v != null && (MODES as string[]).includes(v)
}

function isInterval(v: string | null): v is Interval {
  return v != null && (INTERVALS as string[]).includes(v)
}

/** Normalize pair input: BTC, BTCUSDT, btc/usdt → BTCUSDT */
export function normalizeSymbol(raw: string | null | undefined): string | null {
  if (!raw) return null
  let s = raw.trim().toUpperCase().replace(/[/_\-\s]/g, '')
  if (!s) return null
  if (!s.endsWith('USDT')) s = `${s}USDT`
  if (!/^[A-Z0-9]{2,20}USDT$/.test(s)) return null
  return s
}

function parsePositiveInt(raw: string | null): number | undefined {
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return undefined
  return Math.floor(n)
}

export function readBootParams(search = typeof window !== 'undefined' ? window.location.search : ''): BootParams {
  const p = new URLSearchParams(search)
  const modeRaw = p.get('mode')
  const intervalRaw = p.get('interval') ?? p.get('tf')
  const symbol = normalizeSymbol(p.get('symbol') ?? p.get('pair'))
  const snapshot =
    p.get('snapshot') === '1' ||
    p.get('snapshot') === 'true' ||
    p.get('shot') === '1'
  const visibleBars =
    parsePositiveInt(p.get('bars') ?? p.get('visibleBars')) ??
    (snapshot ? SNAPSHOT_VISIBLE_BARS : undefined)

  return {
    mode: isMode(modeRaw) ? modeRaw : symbol ? 'focus' : undefined,
    symbol: symbol ?? undefined,
    interval: isInterval(intervalRaw) ? intervalRaw : undefined,
    snapshot,
    visibleBars,
  }
}
