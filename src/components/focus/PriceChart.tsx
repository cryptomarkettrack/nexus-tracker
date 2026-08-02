import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { sampleTrendline } from '../../lib/trendlines'
import type { Candle, Trendline, WatchZone } from '../../lib/types'

interface ZoneBox {
  id: string
  top: number
  height: number
  side: 'above' | 'below'
  strength: number
}

function toBar(c: Candle) {
  return {
    time: Math.floor(c.time / 1000) as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }
}

/** True when the chart host has a real layout box (not 0×0 before flex settles). */
function hasLayoutSize(el: HTMLElement | null): boolean {
  if (!el) return false
  const w = el.clientWidth
  const h = el.clientHeight
  return w >= 40 && h >= 40
}

/**
 * Apply time-scale viewport: full history stays in the series (for S/R context),
 * but optionally zoom to the last `visibleBars` candles.
 */
function applyViewport(chart: IChartApi, barCount: number, visibleBars?: number) {
  if (barCount < 1) return
  if (visibleBars != null && visibleBars > 0 && barCount > visibleBars) {
    const from = barCount - visibleBars
    // Small right pad so the latest candle isn't flush against the edge
    const to = barCount - 1 + 2
    chart.timeScale().setVisibleLogicalRange({ from, to })
    return
  }
  chart.timeScale().fitContent()
}

type NexusChartApi = {
  applyZoom: (bars?: number) => void
  barCount: number
  visibleBars?: number
}

declare global {
  interface Window {
    __NEXUS_CHART__?: NexusChartApi
  }
}

export function PriceChart({
  candles,
  trendlines,
  zones,
  livePrice,
  symbol,
  visibleBars,
}: {
  candles: Candle[]
  trendlines: Trendline[]
  zones: WatchZone[]
  livePrice?: number
  symbol: string
  /** When set, zoom to the last N bars instead of fitContent (full data still loaded). */
  visibleBars?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const trendSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const structureKeyRef = useRef('')
  const lastBarTimeRef = useRef(0)
  /** Re-fit once the host gets a non-zero size after data was applied. */
  const needsFitRef = useRef(false)
  const barCountRef = useRef(0)
  const visibleBarsRef = useRef(visibleBars)
  visibleBarsRef.current = visibleBars
  const [zoneBoxes, setZoneBoxes] = useState<ZoneBox[]>([])

  const publishChartApi = () => {
    window.__NEXUS_CHART__ = {
      barCount: barCountRef.current,
      visibleBars: visibleBarsRef.current,
      applyZoom: (bars?: number) => {
        const chart = chartRef.current
        if (!chart || barCountRef.current < 1) return
        const n = bars ?? visibleBarsRef.current
        if (bars != null && Number.isFinite(bars) && bars > 0) {
          visibleBarsRef.current = Math.floor(bars)
        }
        applyViewport(chart, barCountRef.current, n)
      },
    }
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#6f6a60',
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(232,220,196,0.04)' },
        horzLines: { color: 'rgba(232,220,196,0.04)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(232,165,75,0.35)', labelBackgroundColor: '#e8a54b' },
        horzLine: { color: 'rgba(232,165,75,0.35)', labelBackgroundColor: '#e8a54b' },
      },
      rightPriceScale: {
        borderColor: 'rgba(232,220,196,0.08)',
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: 'rgba(232,220,196,0.08)',
        timeVisible: true,
        secondsVisible: false,
      },
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#8fba6b',
      downColor: '#d45d5d',
      borderUpColor: '#8fba6b',
      borderDownColor: '#d45d5d',
      wickUpColor: '#8fba6b',
      wickDownColor: '#d45d5d',
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: 'rgba(232, 165, 75, 0.55)',
      priceLineWidth: 1,
      priceLineStyle: 2,
    })
    chartRef.current = chart
    seriesRef.current = series
    publishChartApi()

    const fitIfNeeded = () => {
      if (!needsFitRef.current || !hasLayoutSize(el)) return
      needsFitRef.current = false
      // Double-rAF: wait for layout + lightweight-charts internal measure
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!chartRef.current || !hasLayoutSize(el)) {
            needsFitRef.current = true
            return
          }
          applyViewport(chartRef.current, barCountRef.current, visibleBarsRef.current)
          publishChartApi()
        })
      })
    }

    const ro = new ResizeObserver(() => {
      fitIfNeeded()
    })
    ro.observe(el)
    // Immediate attempt in case size is already valid
    fitIfNeeded()

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      trendSeriesRef.current = null
      structureKeyRef.current = ''
      needsFitRef.current = false
      if (window.__NEXUS_CHART__) delete window.__NEXUS_CHART__
    }
  }, [])

  // Layout zone overlays from price → pixel
  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series) return

    const updateBoxes = () => {
      const boxes: ZoneBox[] = []
      for (const z of zones) {
        const pad = z.high - z.low < z.mid * 0.0015 ? z.mid * 0.0012 : 0
        const hi = z.high + pad
        const lo = z.low - pad
        const y1 = series.priceToCoordinate(hi)
        const y2 = series.priceToCoordinate(lo)
        if (y1 == null || y2 == null) continue
        const top = Math.min(y1, y2)
        const height = Math.max(6, Math.abs(y2 - y1))
        boxes.push({
          id: z.id,
          top,
          height,
          side: z.side,
          strength: z.strength,
        })
      }
      setZoneBoxes(boxes)
    }

    updateBoxes()
    chart.timeScale().subscribeVisibleLogicalRangeChange(updateBoxes)
    chart.subscribeCrosshairMove(updateBoxes)
    const ro = new ResizeObserver(updateBoxes)
    if (containerRef.current) ro.observe(containerRef.current)
    const id = window.setInterval(updateBoxes, 500)

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(updateBoxes)
      chart.unsubscribeCrosshairMove(updateBoxes)
      ro.disconnect()
      window.clearInterval(id)
    }
  }, [zones, candles])

  useEffect(() => {
    const series = seriesRef.current
    const chart = chartRef.current
    const el = containerRef.current
    if (!series || !chart || !candles.length) return

    const firstT = candles[0]!.time
    const lastT = candles[candles.length - 1]!.time
    // Include last open time so a full history reload always re-applies
    const structureKey = `${symbol}|${candles.length}|${firstT}|${lastT}|${trendlines[0]?.id ?? ''}`
    const structuralChange = structureKey !== structureKeyRef.current

    if (structuralChange) {
      const bars = candles.map(toBar)
      // Guard against malformed / empty after map
      if (bars.length < 2) {
        series.setData(bars)
        structureKeyRef.current = structureKey
        lastBarTimeRef.current = lastT
        return
      }

      series.setData(bars)
      structureKeyRef.current = structureKey
      lastBarTimeRef.current = lastT
      barCountRef.current = bars.length

      if (trendSeriesRef.current) {
        chart.removeSeries(trendSeriesRef.current)
        trendSeriesRef.current = null
      }
      const tl = trendlines[0]
      if (tl && !tl.broken) {
        const lineSeries = chart.addSeries(LineSeries, {
          color: 'rgba(232, 165, 75, 0.55)',
          lineWidth: 1,
          lineStyle: 2,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
          title: '',
        })
        const samples = sampleTrendline(tl, candles, 8)
        const data: { time: Time; value: number }[] = []
        let prevT = -1
        for (const p of samples) {
          const t = Math.floor(p.time / 1000)
          if (t <= prevT || !Number.isFinite(p.value) || p.value <= 0) continue
          data.push({ time: t as Time, value: p.value })
          prevT = t
        }
        if (data.length >= 2) {
          lineSeries.setData(data)
          trendSeriesRef.current = lineSeries
        } else {
          chart.removeSeries(lineSeries)
        }
      }

      // Always schedule a fit; apply immediately only if layout is ready
      needsFitRef.current = true
      publishChartApi()
      if (hasLayoutSize(el)) {
        needsFitRef.current = false
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!chartRef.current) return
            if (!hasLayoutSize(containerRef.current)) {
              needsFitRef.current = true
              return
            }
            applyViewport(chartRef.current, barCountRef.current, visibleBarsRef.current)
            publishChartApi()
          })
        })
      }
    } else {
      const last = candles[candles.length - 1]!
      series.update(toBar(last))
      lastBarTimeRef.current = last.time
      barCountRef.current = candles.length
      publishChartApi()
    }
  }, [candles, trendlines, symbol])

  // Re-zoom when visibleBars changes (e.g. snapshot deep-link) without reloading series
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || barCountRef.current < 1) return
    applyViewport(chart, barCountRef.current, visibleBars)
    publishChartApi()
  }, [visibleBars])

  // Live price tick (may arrive slightly ahead of candle batch)
  useEffect(() => {
    const series = seriesRef.current
    if (!series || !candles.length || livePrice == null || !Number.isFinite(livePrice)) return
    const last = candles[candles.length - 1]!
    series.update({
      time: Math.floor(last.time / 1000) as UTCTimestamp,
      open: last.open,
      high: Math.max(last.high, livePrice),
      low: Math.min(last.low, livePrice),
      close: livePrice,
    })
  }, [livePrice, candles])

  return (
    <div className="chart-wrap chart-wrap--focus">
      <div className="tv-chart" ref={containerRef} />
      <div className="zone-overlay" aria-hidden>
        {zoneBoxes.map((z) => (
          <div
            key={z.id}
            className={`zone-band zone-band--${z.side}`}
            style={{
              top: z.top,
              height: z.height,
              opacity: 0.28 + z.strength * 0.32,
            }}
          />
        ))}
      </div>
    </div>
  )
}
