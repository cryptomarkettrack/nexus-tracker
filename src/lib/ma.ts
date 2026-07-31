import type { Candle, MaKind, MaLevel, MaPeriod, MaTimeframe } from './types'

const PERIODS: MaPeriod[] = [50, 100, 200]
const KINDS: MaKind[] = ['EMA', 'SMA']
export const MA_TIMEFRAMES: MaTimeframe[] = ['4h', '1d', '1w']

/** Bars needed to warm up EMA200 / SMA200 comfortably */
export const MA_KLINE_LIMIT = 250

export function smaSeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = Array(closes.length).fill(null)
  if (closes.length < period) return out
  let sum = 0
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]!
    if (i >= period) sum -= closes[i - period]!
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

export function emaSeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = Array(closes.length).fill(null)
  if (closes.length < period) return out
  const k = 2 / (period + 1)
  // seed with SMA
  let sum = 0
  for (let i = 0; i < period; i++) sum += closes[i]!
  let prev = sum / period
  out[period - 1] = prev
  for (let i = period; i < closes.length; i++) {
    prev = closes[i]! * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

export function latestMa(closes: number[], kind: MaKind, period: number): number | null {
  const series = kind === 'EMA' ? emaSeries(closes, period) : smaSeries(closes, period)
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i]
    if (v != null && Number.isFinite(v)) return v
  }
  return null
}

function tfLabel(tf: MaTimeframe): string {
  if (tf === '4h') return '4H'
  if (tf === '1d') return '1D'
  return '1W'
}

/**
 * Compute EMA/SMA 50·100·200 for each provided TF candle set.
 * Returns only levels within `nearPct` of current price, nearest first.
 */
export function computeNearbyMaLevels(
  byTf: Partial<Record<MaTimeframe, Candle[]>>,
  price: number,
  nearPct = 3.5,
  maxLevels = 8,
): MaLevel[] {
  if (!price || !Number.isFinite(price)) return []
  const all: MaLevel[] = []

  for (const tf of MA_TIMEFRAMES) {
    const candles = byTf[tf]
    if (!candles?.length) continue
    const closes = candles.map((c) => c.close)

    for (const kind of KINDS) {
      for (const period of PERIODS) {
        const ma = latestMa(closes, kind, period)
        if (ma == null) continue
        const distancePct = ((ma - price) / price) * 100
        if (Math.abs(distancePct) > nearPct) continue
        const label = `${kind}${period} ${tfLabel(tf)}`
        all.push({
          id: `${kind}-${period}-${tf}`,
          kind,
          period,
          timeframe: tf,
          price: ma,
          distancePct,
          label,
        })
      }
    }
  }

  // Prefer closer levels; on ties prefer higher TF then longer period
  const tfRank: Record<MaTimeframe, number> = { '1w': 3, '1d': 2, '4h': 1 }
  all.sort((a, b) => {
    const d = Math.abs(a.distancePct) - Math.abs(b.distancePct)
    if (Math.abs(d) > 0.01) return d
    const tr = tfRank[b.timeframe] - tfRank[a.timeframe]
    if (tr) return tr
    return b.period - a.period
  })

  // Drop near-duplicates at almost the same price (keep higher-priority)
  const kept: MaLevel[] = []
  for (const m of all) {
    const dup = kept.some((k) => Math.abs(k.price - m.price) / price < 0.0015)
    if (!dup) kept.push(m)
  }

  return kept.slice(0, maxLevels)
}

/** Color for chart price line by MA family */
export function maLineColor(m: MaLevel): string {
  if (m.kind === 'EMA') {
    if (m.period === 50) return '#6b8fba'
    if (m.period === 100) return '#8b7ec8'
    return '#c47ab0'
  }
  // SMA — warmer / amber family
  if (m.period === 50) return '#e8a54b'
  if (m.period === 100) return '#d4893a'
  return '#b86e2a'
}
