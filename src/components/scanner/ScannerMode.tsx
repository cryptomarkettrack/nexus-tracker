import { useEffect, useMemo, useState } from 'react'
import { formatCompact, formatPrice } from '../../lib/indicators'
import {
  buildScannerSignals,
  playLabel,
  SCANNER_A_CONVICTION,
  type ScannerSignal,
} from '../../lib/scannerSignal'
import type { Interval } from '../../lib/types'
import { SCANNER_INTERVALS, useMarketStore } from '../../stores/marketStore'
import { Panel, Pct, cn } from '../shared/utils'

/** Human label for how much history a TF window covers. */
function windowHint(interval: Interval): string {
  switch (interval) {
    case '15m':
      return '~1d window · 96 bars'
    case '1h':
      return '~3d window · 72 bars'
    case '4h':
      return '~10d window · 60 bars'
    case '1d':
      return '~2mo window · 60 bars'
    default:
      return interval
  }
}

export function ScannerMode() {
  const scannerMetrics = useMarketStore((s) => s.scannerMetrics)
  const scannerWatchLevels = useMarketStore((s) => s.scannerWatchLevels)
  const scannerInterval = useMarketStore((s) => s.scannerInterval)
  const setScannerInterval = useMarketStore((s) => s.setScannerInterval)
  const scannerStatus = useMarketStore((s) => s.scannerStatus)
  const scannerProgress = useMarketStore((s) => s.scannerProgress)
  const scannerError = useMarketStore((s) => s.scannerError)
  const scannerScannedAt = useMarketStore((s) => s.scannerScannedAt)
  const runScanner = useMarketStore((s) => s.runScanner)
  const funding = useMarketStore((s) => s.funding)
  const regime = useMarketStore((s) => s.regime)
  const setFocusSymbol = useMarketStore((s) => s.setFocusSymbol)
  const focusSymbol = useMarketStore((s) => s.focusSymbol)
  const [q, setQ] = useState('')
  const [showB, setShowB] = useState(false)

  // First open of SCAN: auto-run default TF so the board isn't empty
  useEffect(() => {
    if (scannerStatus === 'idle' && scannerMetrics.length === 0) {
      void runScanner()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount / first idle
  }, [])

  const scanning = scannerStatus === 'scanning'
  const hasRun = scannerStatus === 'ready' || scannerMetrics.length > 0

  const { longs, shorts, totalScanned, enriched } = useMemo(() => {
    const boards = buildScannerSignals(scannerMetrics, {
      watchLevels: scannerWatchLevels,
      funding,
      regime,
      includeB: showB,
    })
    let listL = boards.longs
    let listS = boards.shorts
    if (q.trim()) {
      const qq = q.trim().toUpperCase()
      listL = listL.filter((s) => s.base.includes(qq) || s.symbol.includes(qq))
      listS = listS.filter((s) => s.base.includes(qq) || s.symbol.includes(qq))
    }
    return {
      longs: listL,
      shorts: listS,
      totalScanned: scannerMetrics.length,
      enriched: scannerMetrics.filter((m) => m.atrPct > 0).length,
    }
  }, [scannerMetrics, scannerWatchLevels, funding, regime, showB, q])

  const aLongs = longs.filter((s) => s.grade === 'A').length
  const aShorts = shorts.filter((s) => s.grade === 'A').length

  const onPickTf = (iv: Interval) => {
    setScannerInterval(iv)
  }

  const onRun = () => {
    void runScanner(scannerInterval)
  }

  const openFocus = (symbol: string) => {
    // Open FOCUS on the same TF the scan used
    setFocusSymbol(symbol, { interval: scannerInterval })
  }

  const scannedLabel = scannerScannedAt
    ? new Date(scannerScannedAt).toLocaleTimeString()
    : null

  return (
    <div className="mode-view">
      <div className="scanner-hero">
        <div className="scanner-hero__copy">
          <div className="scanner-hero__kicker">Conviction board</div>
          <h2 className="scanner-hero__title">
            LONG / SHORT on{' '}
            <span className="scanner-hero__tf">{scannerInterval}</span>
          </h2>
          <p className="scanner-hero__sub muted">
            Pick a timeframe, run the scan. RSI, range, volume, and relative strength are
            measured on that TF — not mixed with random 24h noise. Tap a row → FOCUS on the
            same interval.
          </p>
        </div>
        <div className="scanner-hero__stats">
          <div className="scanner-stat scanner-stat--long">
            <div className="scanner-stat__label">Long A-grade</div>
            <div className="scanner-stat__value num">{scanning ? '…' : aLongs}</div>
          </div>
          <div className="scanner-stat scanner-stat--short">
            <div className="scanner-stat__label">Short A-grade</div>
            <div className="scanner-stat__value num">{scanning ? '…' : aShorts}</div>
          </div>
          <div className="scanner-stat">
            <div className="scanner-stat__label">Scanned</div>
            <div className="scanner-stat__value num">
              {scanning ? scannerProgress.done : enriched}
              <span className="scanner-stat__suffix muted">
                /{scanning ? scannerProgress.total : totalScanned || '—'}
              </span>
            </div>
          </div>
          {regime && (
            <div className={cn('scanner-stat', `scanner-stat--${regime.bias}`)}>
              <div className="scanner-stat__label">Regime</div>
              <div className="scanner-stat__value scanner-stat__value--sm">{regime.label}</div>
            </div>
          )}
        </div>
        <div className="scanner-hero__controls">
          <div className="scanner-tf">
            <div className="filter-label">Timeframe</div>
            <div className="chip-row chip-row--scroll scanner-tf__chips">
              {SCANNER_INTERVALS.map((iv) => (
                <button
                  key={iv}
                  type="button"
                  className={cn('chip', scannerInterval === iv && 'active')}
                  disabled={scanning}
                  onClick={() => onPickTf(iv)}
                >
                  {iv}
                </button>
              ))}
            </div>
            <div className="scanner-tf__hint muted">{windowHint(scannerInterval)}</div>
          </div>
          <button
            type="button"
            className={cn('scanner-run', scanning && 'scanner-run--busy')}
            disabled={scanning}
            onClick={onRun}
          >
            {scanning
              ? `Scanning ${scannerInterval}… ${scannerProgress.done}/${scannerProgress.total}`
              : `Run ${scannerInterval} scan`}
          </button>
          {scannedLabel && !scanning && (
            <div className="scanner-hero__meta muted">
              Last run · {scannerInterval} · {scannedLabel}
            </div>
          )}
          <input
            className="search-input scanner-hero__search"
            placeholder="Filter symbol…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            enterKeyHint="search"
          />
          <button
            type="button"
            className={cn('chip', showB && 'active')}
            onClick={() => setShowB((v) => !v)}
            title={`A-grade needs conviction ≥ ${SCANNER_A_CONVICTION}`}
          >
            {showB ? 'A + B grades' : 'A-grade only'}
          </button>
        </div>
      </div>

      {scannerError && (
        <div className="scanner-banner scanner-banner--error">{scannerError}</div>
      )}

      {scanning && (
        <div className="scanner-banner scanner-banner--progress">
          <div className="scanner-banner__bar">
            <div
              className="scanner-banner__fill"
              style={{
                width: `${scannerProgress.total ? (100 * scannerProgress.done) / scannerProgress.total : 0}%`,
              }}
            />
          </div>
          <span>
            Fetching {scannerInterval} candles for top liquid pairs…
          </span>
        </div>
      )}

      {!hasRun && !scanning && (
        <div className="scanner-empty scanner-empty--center">
          <div className="scanner-empty__title">Choose a timeframe and run the scan</div>
          <p className="muted">
            Default is 4h. Results use that TF’s RSI, range position, volume, and change vs BTC.
          </p>
          <button type="button" className="scanner-run" onClick={onRun}>
            Run {scannerInterval} scan
          </button>
        </div>
      )}

      {(hasRun || scanning) && (
        <div className="grid-scanner-boards">
          <Panel
            title={`LONG · ${scannerInterval}`}
            meta={scanning ? 'updating…' : `${longs.length} high conviction`}
            className="scanner-board scanner-board--long"
            bodyClassName="scroll-y scanner-board__body"
          >
            <div className="scanner-board__banner scanner-board__banner--long">
              <span className="scanner-board__side">Buy dips / ride strength</span>
              <span className="muted">
                Measured on {scannerInterval} · bounce · breakout · beat BTC
              </span>
            </div>
            {scanning && !longs.length ? (
              <div className="scanner-empty">
                <div className="scanner-empty__title">Scanning…</div>
              </div>
            ) : longs.length === 0 ? (
              <EmptyBoard side="long" showB={showB} onShowB={() => setShowB(true)} tf={scannerInterval} />
            ) : (
              <div className="scanner-signal-list" role="list">
                {longs.map((s) => (
                  <SignalCard
                    key={s.symbol}
                    signal={s}
                    interval={scannerInterval}
                    active={focusSymbol === s.symbol}
                    onOpen={() => openFocus(s.symbol)}
                  />
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title={`SHORT · ${scannerInterval}`}
            meta={scanning ? 'updating…' : `${shorts.length} high conviction`}
            className="scanner-board scanner-board--short"
            bodyClassName="scroll-y scanner-board__body"
          >
            <div className="scanner-board__banner scanner-board__banner--short">
              <span className="scanner-board__side">Fade rips / ride weakness</span>
              <span className="muted">
                Measured on {scannerInterval} · fade · breakdown · lag BTC
              </span>
            </div>
            {scanning && !shorts.length ? (
              <div className="scanner-empty">
                <div className="scanner-empty__title">Scanning…</div>
              </div>
            ) : shorts.length === 0 ? (
              <EmptyBoard side="short" showB={showB} onShowB={() => setShowB(true)} tf={scannerInterval} />
            ) : (
              <div className="scanner-signal-list" role="list">
                {shorts.map((s) => (
                  <SignalCard
                    key={s.symbol}
                    signal={s}
                    interval={scannerInterval}
                    active={focusSymbol === s.symbol}
                    onOpen={() => openFocus(s.symbol)}
                  />
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  )
}

function EmptyBoard({
  side,
  showB,
  onShowB,
  tf,
}: {
  side: 'long' | 'short'
  showB: boolean
  onShowB: () => void
  tf: Interval
}) {
  return (
    <div className="scanner-empty">
      <div className="scanner-empty__title">
        No {side === 'long' ? 'LONG' : 'SHORT'} edges on {tf}
      </div>
      <p className="muted">
        Nothing clears the multi-factor bar on this timeframe. Try another TF, or wait for a
        cleaner setup.
      </p>
      {!showB && (
        <button type="button" className="chip" onClick={onShowB}>
          Include B-grade candidates
        </button>
      )}
    </div>
  )
}

function SignalCard({
  signal: s,
  interval,
  active,
  onOpen,
}: {
  signal: ScannerSignal
  interval: Interval
  active: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      role="listitem"
      className={cn(
        'scanner-signal',
        `scanner-signal--${s.side}`,
        s.grade === 'A' && 'scanner-signal--a',
        active && 'active',
      )}
      onClick={onOpen}
    >
      <div className="scanner-signal__head">
        <div className="scanner-signal__id">
          <strong className="scanner-signal__base">{s.base}</strong>
          <span className={cn('scanner-signal__side-tag', `scanner-signal__side-tag--${s.side}`)}>
            {s.side.toUpperCase()}
          </span>
          <span className="tag scanner-signal__play">{playLabel(s.play)}</span>
          <span className="tag scanner-signal__tf">{interval}</span>
          {s.grade === 'B' && <span className="tag scanner-signal__grade">B</span>}
        </div>
        <div className="scanner-signal__conv">
          <span className="scanner-signal__conv-val num">{s.conviction}</span>
          <span className="scanner-signal__conv-label muted">conv</span>
        </div>
      </div>

      <div className="scanner-signal__metrics">
        <span className="num">{formatPrice(s.price)}</span>
        <Pct value={s.change24h} />
        <span className="muted">vs BTC</span>
        <Pct value={s.relStrengthBtc} />
        <span
          className={cn(
            'num',
            s.rsi > 70 ? 'down' : s.rsi < 30 ? 'up' : 'muted',
          )}
        >
          RSI {s.rsi.toFixed(0)}
        </span>
        <span className="muted">Vol {s.volumeAnomaly.toFixed(1)}×</span>
        <span className="muted">{formatCompact(s.quoteVolume)}</span>
      </div>

      <div className="scanner-signal__range" title={`Position in ${interval} window range`}>
        <div className="bar-track">
          <div
            className={cn('bar-fill', s.side === 'long' ? 'teal' : 'down')}
            style={{ width: `${Math.max(4, s.rangePosition * 100)}%` }}
          />
        </div>
        <span className="muted num">{(s.rangePosition * 100).toFixed(0)}%</span>
      </div>

      <div className="scanner-signal__thesis">{s.thesis}</div>
      {s.drivers.length > 1 && (
        <ul className="scanner-signal__drivers">
          {s.drivers.slice(0, 3).map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </button>
  )
}
