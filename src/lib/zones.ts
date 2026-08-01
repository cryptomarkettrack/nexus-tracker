import type { Level, MaLevel, Trendline, WatchZone } from './types'

export interface ZoneSource {
  price: number
  label: string
  weight?: number
}

/**
 * Cluster nearby price levels into soft watch zones.
 * Returns at most one zone above and one below current price (nearest confluence).
 */
export function buildWatchZones(
  price: number,
  sources: ZoneSource[],
  opts: { clusterPct?: number; maxDistPct?: number } = {},
): WatchZone[] {
  if (!price || !sources.length) return []
  const clusterPct = opts.clusterPct ?? 0.55
  const maxDistPct = opts.maxDistPct ?? 4.5

  const filtered = sources
    .filter((s) => Number.isFinite(s.price) && s.price > 0)
    .filter((s) => (Math.abs(s.price - price) / price) * 100 <= maxDistPct)
    .sort((a, b) => a.price - b.price)

  if (!filtered.length) return []

  // Greedy cluster by price proximity
  type Cluster = { items: ZoneSource[]; low: number; high: number }
  const clusters: Cluster[] = []
  for (const s of filtered) {
    const last = clusters[clusters.length - 1]
    if (last && ((s.price - last.high) / price) * 100 <= clusterPct) {
      last.items.push(s)
      last.high = Math.max(last.high, s.price)
      last.low = Math.min(last.low, s.price)
    } else {
      clusters.push({ items: [s], low: s.price, high: s.price })
    }
  }

  const zones: WatchZone[] = clusters.map((c, i) => {
    const weights = c.items.map((it) => it.weight ?? 1)
    const wSum = weights.reduce((a, b) => a + b, 0)
    const mid =
      c.items.reduce((a, it, j) => a + it.price * (weights[j] ?? 1), 0) / wSum
    const distancePct = ((mid - price) / price) * 100
    const labels = uniqueLabels(c.items.map((it) => it.label))
    return {
      id: `zone-${i}-${mid.toFixed(2)}`,
      side: mid >= price ? 'above' : 'below',
      low: c.low,
      high: c.high,
      mid,
      strength: Math.min(1, c.items.length / 4 + (c.items.length > 1 ? 0.25 : 0)),
      sources: labels,
      distancePct,
      label: zoneTitle(mid >= price ? 'above' : 'below', labels, c.items.length),
    }
  })

  // Nearest strong zone above + below (prefer multi-source confluence)
  const above = zones
    .filter((z) => z.side === 'above')
    .sort((a, b) => scoreZone(a) - scoreZone(b))
  const below = zones
    .filter((z) => z.side === 'below')
    .sort((a, b) => scoreZone(a) - scoreZone(b))

  const out: WatchZone[] = []
  if (above[0]) out.push(above[0])
  if (below[0]) out.push(below[0])
  return out.sort((a, b) => b.mid - a.mid)
}

function scoreZone(z: WatchZone): number {
  // lower is better: prefer closer, then stronger confluence
  return Math.abs(z.distancePct) - z.sources.length * 0.35 - z.strength * 0.5
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of labels) {
    if (seen.has(l)) continue
    seen.add(l)
    out.push(l)
  }
  return out
}

function zoneTitle(side: 'above' | 'below', labels: string[], n: number): string {
  const dir = side === 'above' ? 'Resistance' : 'Support'
  if (n >= 3) return `${dir} confluence`
  if (n === 2) return `${dir} zone`
  // Always keep structural role clear (avoid "Pressing SUPPORT" for a level above price)
  const raw = labels[0]
  if (!raw) return dir
  const upper = raw.toUpperCase()
  if (side === 'above' && (upper === 'SUPPORT' || upper.includes('SUPPORT'))) {
    return `Resistance (${raw})`
  }
  if (side === 'below' && (upper === 'RESISTANCE' || upper.includes('RESISTANCE'))) {
    return `Support (${raw})`
  }
  return raw
}

/** Gather MA + structure + trendline into zone sources */
export function collectZoneSources(
  price: number,
  maLevels: MaLevel[],
  levels: Level[],
  trendlines: Trendline[],
): ZoneSource[] {
  const sources: ZoneSource[] = []

  for (const m of maLevels) {
    sources.push({
      price: m.price,
      label: m.label,
      weight: m.period === 200 ? 1.4 : m.period === 100 ? 1.15 : 1,
    })
  }

  for (const l of levels) {
    sources.push({
      price: l.price,
      label: l.type.toUpperCase(),
      weight: l.type === 'poc' ? 1.3 : 1,
    })
  }

  // If structure levels empty, still try raw nearest from MAs only
  const tl = trendlines[0]
  if (tl && !tl.broken) {
    const dist = Math.abs(tl.currentPrice - price) / price
    if (dist < 0.05) {
      sources.push({
        price: tl.currentPrice,
        label: 'Peak TL',
        weight: 1.2,
      })
    }
  }

  return sources
}
