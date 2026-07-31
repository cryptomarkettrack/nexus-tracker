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
import { formatPrice } from '../../lib/indicators'
import { sampleTrendline } from '../../lib/trendlines'
import type { Candle, Trendline, WatchZone } from '../../lib/types'

interface ZoneBox {
  id: string
  top: number
  height: number
  side: 'above' | 'below'
  label: string
  midLabel: string
  strength: number
}

export function PriceChart({
  candles,
  trendlines,
  zones,
  livePrice,
  symbol,
}: {
  candles: Candle[]
  trendlines: Trendline[]
  zones: WatchZone[]
  livePrice?: number
  symbol: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const trendSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const [zoneBoxes, setZoneBoxes] = useState<ZoneBox[]>([])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
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
    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      trendSeriesRef.current = null
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
        // ensure band has visual thickness even for single-level clusters
        const pad = (z.high - z.low) < z.mid * 0.0015 ? z.mid * 0.0012 : 0
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
          label: z.label,
          midLabel: formatPrice(z.mid),
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

  const structureKeyRef = useRef('')
  const lastBarTimeRef = useRef(0)

  useEffect(() => {
    const series = seriesRef.current
    const chart = chartRef.current
    if (!series || !chart || !candles.length) return

    const firstT = candles[0]!.time
    const lastT = candles[candles.length - 1]!.time
    const structureKey = `${symbol}|${candles.length}|${firstT}|${trendlines[0]?.id ?? ''}`
    const structuralChange = structureKey !== structureKeyRef.current

    if (structuralChange) {
      series.setData(
        candles.map((c) => ({
          time: Math.floor(c.time / 1000) as Time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      )
      structureKeyRef.current = structureKey
      lastBarTimeRef.current = lastT

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

      chart.timeScale().fitContent()
    } else {
      // live bar update only
      const last = candles[candles.length - 1]!
      series.update({
        time: Math.floor(last.time / 1000) as UTCTimestamp,
        open: last.open,
        high: last.high,
        low: last.low,
        close: last.close,
      })
      lastBarTimeRef.current = last.time
    }
  }, [candles, trendlines, symbol])

  // Live price tick (may arrive slightly ahead of candle batch)
  useEffect(() => {
    const series = seriesRef.current
    if (!series || !candles.length || livePrice == null || !Number.isFinite(livePrice)) return
    const last = candles[candles.length - 1]!
    const time = Math.floor(last.time / 1000) as UTCTimestamp
    series.update({
      time,
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
              opacity: 0.35 + z.strength * 0.35,
            }}
          >
            <span className="zone-band__tag">
              {z.label}
              <em>{z.midLabel}</em>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
