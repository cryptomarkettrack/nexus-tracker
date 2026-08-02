import type {
  CoinMetrics,
  FundingInfo,
  MarketRegime,
  WatchLevel,
} from './types'

export type ScannerSide = 'long' | 'short'

/** Playbook archetype for the signal (shown as a small tag). */
export type ScannerPlay =
  | 'bounce'
  | 'breakout'
  | 'rel-strength'
  | 'fade'
  | 'breakdown'
  | 'rel-weakness'

export interface ScannerSignal {
  symbol: string
  base: string
  side: ScannerSide
  /** 0–100 conviction after gates */
  conviction: number
  /** A = show by default; B = optional lower bar */
  grade: 'A' | 'B'
  play: ScannerPlay
  thesis: string
  drivers: string[]
  price: number
  change24h: number
  relStrengthBtc: number
  rsi: number
  volumeAnomaly: number
  atrPct: number
  rangePosition: number
  quoteVolume: number
  setup: CoinMetrics['setup']
}

/** Minimum quote volume (USDT) to appear on the board. */
export const SCANNER_MIN_QUOTE_VOL = 1_500_000
/** A-grade bar — multi-factor confluence only. */
export const SCANNER_A_CONVICTION = 68
/** B-grade bar — still selective, used for “show more”. */
export const SCANNER_B_CONVICTION = 54
/** Need at least this many independent drivers. */
const MIN_DRIVERS_A = 2
const MIN_DRIVERS_B = 2

/**
 * Rank directional opportunities from scanner metrics.
 * Full history / zones are not required — uses 24h structure, RSI, vol, RS vs BTC,
 * optional nearby S/R from watch levels, funding, and market regime.
 *
 * Philosophy: empty board > noisy board. Only multi-factor confluence passes.
 */
export function buildScannerSignals(
  metrics: CoinMetrics[],
  opts: {
    watchLevels?: WatchLevel[]
    funding?: Map<string, FundingInfo>
    regime?: MarketRegime | null
    /** Include B-grade (default false for the main boards). */
    includeB?: boolean
    minQuoteVol?: number
  } = {},
): { longs: ScannerSignal[]; shorts: ScannerSignal[] } {
  const {
    watchLevels = [],
    funding,
    regime = null,
    includeB = false,
    minQuoteVol = SCANNER_MIN_QUOTE_VOL,
  } = opts

  const levelsBySymbol = groupWatchLevels(watchLevels)
  const longs: ScannerSignal[] = []
  const shorts: ScannerSignal[] = []

  for (const m of metrics) {
    if (m.quoteVolume < minQuoteVol) continue
    // Need candle enrichment for RSI/ATR — skip pure-ticker placeholders
    if (!Number.isFinite(m.rsi) || m.atrPct <= 0) continue

    const near = levelsBySymbol.get(m.symbol) ?? []
    const fund = funding?.get(m.symbol)
    const long = scoreSide(m, 'long', near, fund, regime)
    const short = scoreSide(m, 'short', near, fund, regime)

    // Pick the stronger side only — never both
    const best =
      long.conviction >= short.conviction
        ? { side: 'long' as const, ...long }
        : { side: 'short' as const, ...short }

    if (best.conviction < SCANNER_B_CONVICTION) continue
    if (best.grade === 'B' && !includeB) continue
    if (best.grade === 'A' && best.drivers.length < MIN_DRIVERS_A) continue
    if (best.grade === 'B' && best.drivers.length < MIN_DRIVERS_B) continue

    const signal: ScannerSignal = {
      symbol: m.symbol,
      base: m.base,
      side: best.side,
      conviction: best.conviction,
      grade: best.grade,
      play: best.play,
      thesis: best.thesis,
      drivers: best.drivers,
      price: m.price,
      change24h: m.change24h,
      relStrengthBtc: m.relStrengthBtc,
      rsi: m.rsi,
      volumeAnomaly: m.volumeAnomaly,
      atrPct: m.atrPct,
      rangePosition: m.rangePosition,
      quoteVolume: m.quoteVolume,
      setup: m.setup,
    }

    if (best.side === 'long') longs.push(signal)
    else shorts.push(signal)
  }

  longs.sort((a, b) => b.conviction - a.conviction || b.quoteVolume - a.quoteVolume)
  shorts.sort((a, b) => b.conviction - a.conviction || b.quoteVolume - a.quoteVolume)

  // Cap board size so the page stays scannable
  return {
    longs: longs.slice(0, 12),
    shorts: shorts.slice(0, 12),
  }
}

function groupWatchLevels(levels: WatchLevel[]): Map<string, WatchLevel[]> {
  const map = new Map<string, WatchLevel[]>()
  for (const w of levels) {
    const list = map.get(w.symbol)
    if (list) list.push(w)
    else map.set(w.symbol, [w])
  }
  return map
}

function scoreSide(
  m: CoinMetrics,
  side: ScannerSide,
  nearLevels: WatchLevel[],
  funding: FundingInfo | undefined,
  regime: MarketRegime | null,
): {
  conviction: number
  grade: 'A' | 'B'
  play: ScannerPlay
  thesis: string
  drivers: string[]
} {
  let score = 0
  const drivers: string[] = []
  let play: ScannerPlay = side === 'long' ? 'bounce' : 'fade'
  let playWeight = 0

  const supportNear = nearLevels.find(
    (l) => l.side === 'below' && Math.abs(l.distancePct) <= 1.4,
  )
  const resistNear = nearLevels.find(
    (l) => l.side === 'above' && Math.abs(l.distancePct) <= 1.4,
  )

  if (side === 'long') {
    // ——— Mean-reversion bounce (best A-grade long) ———
    if (m.rsi <= 28 && m.rangePosition <= 0.2) {
      const w = 38
      score += w
      drivers.push(`RSI ${m.rsi.toFixed(0)} flush at range lows`)
      if (w > playWeight) {
        play = 'bounce'
        playWeight = w
      }
    } else if (m.rsi <= 34 && m.rangePosition <= 0.28) {
      const w = 24
      score += w
      drivers.push(`RSI ${m.rsi.toFixed(0)} soft oversold near lows`)
      if (w > playWeight) {
        play = 'bounce'
        playWeight = w
      }
    }

    // Support structure from watch map
    if (supportNear) {
      score += 14 + supportNear.strength * 8
      drivers.push(
        `${supportNear.type.toUpperCase()} support @ ${absPct(supportNear.distancePct)}`,
      )
    }

    // ——— Momentum / breakout long ———
    if (
      m.distanceToHigh <= 1.8 &&
      m.volumeAnomaly >= 2.0 &&
      m.change24h >= 2.5 &&
      m.rsi >= 48 &&
      m.rsi <= 72
    ) {
      const w = 34
      score += w
      drivers.push(`Vol ${m.volumeAnomaly.toFixed(1)}× breakout near 24h high`)
      if (w > playWeight) {
        play = 'breakout'
        playWeight = w
      }
    }

    // Relative strength continuation
    if (m.relStrengthBtc >= 4.5 && m.change24h >= 1.5 && m.rangePosition >= 0.45) {
      const w = 28
      score += w
      drivers.push(`+${m.relStrengthBtc.toFixed(1)}pp vs BTC (rel. strength)`)
      if (w > playWeight) {
        play = 'rel-strength'
        playWeight = w
      }
    } else if (m.relStrengthBtc >= 2.5 && m.change24h > 0) {
      score += 10
      drivers.push(`Beating BTC by ${m.relStrengthBtc.toFixed(1)}pp`)
    }

    // Volume confirmation (required-ish for A)
    if (m.volumeAnomaly >= 2.2) {
      score += 12
      drivers.push(`Participation ${m.volumeAnomaly.toFixed(1)}× avg`)
    } else if (m.volumeAnomaly >= 1.4) {
      score += 6
      drivers.push(`Vol ${m.volumeAnomaly.toFixed(1)}× confirms`)
    } else if (m.volumeAnomaly < 0.75 && play !== 'bounce') {
      score -= 18 // dead tape — not a real breakout
    }

    // Setup tag alignment
    if (m.setup === 'breakout' || m.setup === 'strength') {
      score += 8
      drivers.push(m.setupReason)
    }
    if (m.setup === 'mean-reversion' && m.rsi < 40) {
      score += 10
      drivers.push(m.setupReason)
    }
    if (m.setup === 'weakness') score -= 22
    if (m.setup === 'squeeze') score -= 12 // wait for expansion

    // Funding: crowded longs hurt; crowded shorts help
    if (funding) {
      if (funding.fundingRate > 0.0005) {
        score -= 10
        drivers.push('Crowded longs (funding)')
      } else if (funding.fundingRate < -0.00015) {
        score += 8
        drivers.push('Crowded shorts — squeeze fuel')
      }
    }

    // Regime tailwind
    if (regime?.bias === 'risk-on') score += 6
    if (regime?.bias === 'risk-off') score -= 8

    // ——— Hard blocks (longs) ———
    if (m.rsi >= 74 && m.rangePosition >= 0.88) {
      score = 0
      drivers.length = 0
      drivers.push('Blocked: chasing highs while overbought')
    }
    if (resistNear && m.rsi >= 62 && play !== 'breakout') {
      score -= 20
      drivers.push('Blocked soft: pressing resistance into overbought')
    }
    if (m.change24h <= -14 && m.rsi < 30 && !supportNear) {
      score -= 16
      drivers.push('Knife without structure')
    }
    // Chase long with no support and RSI already hot
    if (m.rsi > 65 && m.rangePosition > 0.8 && play === 'rel-strength' && m.volumeAnomaly < 1.8) {
      score -= 18
    }
  } else {
    // ——— Fade overbought (best A-grade short) ———
    if (m.rsi >= 72 && m.rangePosition >= 0.82) {
      const w = 38
      score += w
      drivers.push(`RSI ${m.rsi.toFixed(0)} stretched at range highs`)
      if (w > playWeight) {
        play = 'fade'
        playWeight = w
      }
    } else if (m.rsi >= 66 && m.rangePosition >= 0.75) {
      const w = 24
      score += w
      drivers.push(`RSI ${m.rsi.toFixed(0)} soft overbought near highs`)
      if (w > playWeight) {
        play = 'fade'
        playWeight = w
      }
    }

    if (resistNear) {
      score += 14 + resistNear.strength * 8
      drivers.push(
        `${resistNear.type.toUpperCase()} resistance @ ${absPct(resistNear.distancePct)}`,
      )
    }

    // ——— Breakdown short ———
    if (
      m.distanceToLow <= 1.8 &&
      m.volumeAnomaly >= 2.0 &&
      m.change24h <= -2.5 &&
      m.rsi <= 52 &&
      m.rsi >= 28
    ) {
      const w = 34
      score += w
      drivers.push(`Vol ${m.volumeAnomaly.toFixed(1)}× breakdown near 24h low`)
      if (w > playWeight) {
        play = 'breakdown'
        playWeight = w
      }
    }

    // Relative weakness
    if (m.relStrengthBtc <= -4.5 && m.change24h <= -1.5 && m.rangePosition <= 0.55) {
      const w = 28
      score += w
      drivers.push(`${m.relStrengthBtc.toFixed(1)}pp vs BTC (rel. weakness)`)
      if (w > playWeight) {
        play = 'rel-weakness'
        playWeight = w
      }
    } else if (m.relStrengthBtc <= -2.5 && m.change24h < 0) {
      score += 10
      drivers.push(`Lagging BTC by ${Math.abs(m.relStrengthBtc).toFixed(1)}pp`)
    }

    if (m.volumeAnomaly >= 2.2) {
      score += 12
      drivers.push(`Participation ${m.volumeAnomaly.toFixed(1)}× avg`)
    } else if (m.volumeAnomaly >= 1.4) {
      score += 6
      drivers.push(`Vol ${m.volumeAnomaly.toFixed(1)}× confirms`)
    } else if (m.volumeAnomaly < 0.75 && play !== 'fade') {
      score -= 18
    }

    if (m.setup === 'weakness') {
      score += 10
      drivers.push(m.setupReason)
    }
    if (m.setup === 'mean-reversion' && m.rsi > 60) {
      score += 10
      drivers.push(m.setupReason)
    }
    if (m.setup === 'breakout' || m.setup === 'strength') score -= 22
    if (m.setup === 'squeeze') score -= 12

    if (funding) {
      if (funding.fundingRate > 0.0005) {
        score += 8
        drivers.push('Crowded longs — fade fuel')
      } else if (funding.fundingRate < -0.00015) {
        score -= 10
        drivers.push('Crowded shorts (funding)')
      }
    }

    if (regime?.bias === 'risk-off') score += 6
    if (regime?.bias === 'risk-on') score -= 8

    // ——— Hard blocks (shorts) ———
    if (m.rsi <= 28 && m.rangePosition <= 0.18) {
      score = 0
      drivers.length = 0
      drivers.push('Blocked: shorting capitulation lows')
    }
    if (supportNear && m.rsi <= 42 && play !== 'breakdown') {
      score -= 20
      drivers.push('Blocked soft: shorting into support while soft RSI')
    }
    if (m.change24h >= 14 && m.rsi > 70 && !resistNear) {
      score -= 16
      drivers.push('Melt-up without resistance structure')
    }
    if (m.rsi < 35 && m.rangePosition < 0.2 && play === 'rel-weakness' && m.volumeAnomaly < 1.8) {
      score -= 18
    }
  }

  // Liquidity quality soft bonus (already filtered min)
  if (m.quoteVolume >= 10_000_000) score += 4
  if (m.spreadBps > 12) score -= 8 // wide spread = skip

  // ATR: prefer tradable volatility (not dead, not insane)
  if (m.atrPct >= 0.8 && m.atrPct <= 6) score += 4
  if (m.atrPct > 12) score -= 10

  const conviction = Math.max(0, Math.min(100, Math.round(score)))
  let grade: 'A' | 'B' = conviction >= SCANNER_A_CONVICTION ? 'A' : 'B'

  // A requires multi-driver confluence
  if (grade === 'A' && drivers.length < MIN_DRIVERS_A) grade = 'B'
  // A bounce/fade should have RSI structure
  if (grade === 'A' && side === 'long' && play === 'bounce' && m.rsi > 36) grade = 'B'
  if (grade === 'A' && side === 'short' && play === 'fade' && m.rsi < 64) grade = 'B'
  // A breakout/breakdown needs real volume
  if (grade === 'A' && (play === 'breakout' || play === 'breakdown') && m.volumeAnomaly < 1.8) {
    grade = 'B'
  }

  const thesis = buildThesis(side, play, m, drivers)

  return { conviction, grade, play, thesis, drivers: drivers.slice(0, 5) }
}

function buildThesis(
  side: ScannerSide,
  play: ScannerPlay,
  m: CoinMetrics,
  drivers: string[],
): string {
  const head =
    side === 'long'
      ? play === 'bounce'
        ? 'Long bounce'
        : play === 'breakout'
          ? 'Long breakout'
          : 'Long strength'
      : play === 'fade'
        ? 'Short fade'
        : play === 'breakdown'
          ? 'Short breakdown'
          : 'Short weakness'

  const core = drivers[0] ?? m.setupReason
  return `${head}: ${core}`
}

function absPct(n: number): string {
  const a = Math.abs(n)
  return `${n >= 0 ? '+' : '−'}${a.toFixed(2)}%`
}

export function playLabel(play: ScannerPlay): string {
  switch (play) {
    case 'bounce':
      return 'Bounce'
    case 'breakout':
      return 'Breakout'
    case 'rel-strength':
      return 'Rel. strength'
    case 'fade':
      return 'Fade'
    case 'breakdown':
      return 'Breakdown'
    case 'rel-weakness':
      return 'Rel. weakness'
  }
}
