import type { Candle, FundingInfo, Interval, OrderBook, Ticker24h } from './types'

const SPOT_REST = 'https://api.binance.com'
const FUTURES_REST = 'https://fapi.binance.com'
const SPOT_WS = 'wss://stream.binance.com:9443/ws'
const SPOT_WS_COMBINED = 'wss://stream.binance.com:9443/stream'

const STABLE = new Set([
  'USDC',
  'BUSD',
  'TUSD',
  'FDUSD',
  'DAI',
  'USDP',
  'USDD',
  'EUR',
  'AEUR',
  'USD1',
])

export function baseFromSymbol(symbol: string): string {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol
}

export function isTradeableUsdt(symbol: string): boolean {
  if (!symbol.endsWith('USDT')) return false
  const base = baseFromSymbol(symbol)
  if (STABLE.has(base)) return false
  if (symbol.includes('_') || symbol.includes('UP') || symbol.includes('DOWN')) return false
  // leverage tokens
  if (/.*(UP|DOWN|BULL|BEAR)USDT$/.test(symbol) && base.length > 6) return false
  return true
}

function parseTicker(raw: Record<string, string>): Ticker24h | null {
  const symbol = raw.symbol
  if (!symbol || !isTradeableUsdt(symbol)) return null
  return {
    symbol,
    base: baseFromSymbol(symbol),
    lastPrice: parseFloat(raw.lastPrice),
    priceChange: parseFloat(raw.priceChange),
    priceChangePercent: parseFloat(raw.priceChangePercent),
    highPrice: parseFloat(raw.highPrice),
    lowPrice: parseFloat(raw.lowPrice),
    volume: parseFloat(raw.volume),
    quoteVolume: parseFloat(raw.quoteVolume),
    openPrice: parseFloat(raw.openPrice),
    weightedAvgPrice: parseFloat(raw.weightedAvgPrice),
    count: parseInt(raw.count, 10),
    bidPrice: parseFloat(raw.bidPrice || '0'),
    askPrice: parseFloat(raw.askPrice || '0'),
  }
}

export async function fetchAllTickers(): Promise<Ticker24h[]> {
  const res = await fetch(`${SPOT_REST}/api/v3/ticker/24hr`)
  if (!res.ok) throw new Error(`ticker/24hr ${res.status}`)
  const data = (await res.json()) as Record<string, string>[]
  const tickers: Ticker24h[] = []
  for (const raw of data) {
    const t = parseTicker(raw)
    if (t && t.quoteVolume > 50_000) tickers.push(t)
  }
  return tickers.sort((a, b) => b.quoteVolume - a.quoteVolume)
}

/** Binance REST max candles per `/api/v3/klines` request */
export const KLINES_MAX_LIMIT = 1000

export async function fetchKlines(
  symbol: string,
  interval: Interval,
  limit = KLINES_MAX_LIMIT,
): Promise<Candle[]> {
  const capped = Math.min(Math.max(1, limit), KLINES_MAX_LIMIT)
  const url = `${SPOT_REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${capped}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`klines ${symbol} ${res.status}`)
  const data = (await res.json()) as (string | number)[][]
  return data.map((k) => ({
    time: Number(k[0]),
    open: parseFloat(String(k[1])),
    high: parseFloat(String(k[2])),
    low: parseFloat(String(k[3])),
    close: parseFloat(String(k[4])),
    volume: parseFloat(String(k[5])),
    quoteVolume: parseFloat(String(k[7])),
    trades: Number(k[8]),
    takerBuyBase: parseFloat(String(k[9])),
    takerBuyQuote: parseFloat(String(k[10])),
  }))
}

export async function fetchDepth(symbol: string, limit = 20): Promise<OrderBook> {
  const res = await fetch(`${SPOT_REST}/api/v3/depth?symbol=${symbol}&limit=${limit}`)
  if (!res.ok) throw new Error(`depth ${symbol} ${res.status}`)
  const data = (await res.json()) as {
    lastUpdateId: number
    bids: [string, string][]
    asks: [string, string][]
  }
  return {
    lastUpdateId: data.lastUpdateId,
    bids: data.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    asks: data.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
  }
}

export async function fetchFundingRates(symbols?: string[]): Promise<Map<string, FundingInfo>> {
  const res = await fetch(`${FUTURES_REST}/fapi/v1/premiumIndex`)
  if (!res.ok) throw new Error(`premiumIndex ${res.status}`)
  const data = (await res.json()) as {
    symbol: string
    lastFundingRate: string
    markPrice: string
    nextFundingTime: number
  }[]
  const map = new Map<string, FundingInfo>()
  for (const d of data) {
    if (!d.symbol.endsWith('USDT')) continue
    if (symbols && !symbols.includes(d.symbol)) continue
    map.set(d.symbol, {
      symbol: d.symbol,
      fundingRate: parseFloat(d.lastFundingRate),
      markPrice: parseFloat(d.markPrice),
      nextFundingTime: d.nextFundingTime,
    })
  }
  return map
}

type WsHandler = (data: unknown) => void

export class BinanceSocket {
  private ws: WebSocket | null = null
  private streams = new Set<string>()
  private handlers = new Map<string, Set<WsHandler>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false
  private statusCb: ((s: 'connecting' | 'live' | 'disconnected') => void) | null = null

  onStatus(cb: (s: 'connecting' | 'live' | 'disconnected') => void) {
    this.statusCb = cb
  }

  private setStatus(s: 'connecting' | 'live' | 'disconnected') {
    this.statusCb?.(s)
  }

  subscribe(stream: string, handler: WsHandler) {
    if (!this.handlers.has(stream)) this.handlers.set(stream, new Set())
    this.handlers.get(stream)!.add(handler)
    this.streams.add(stream)
    this.reconnect()
    return () => this.unsubscribe(stream, handler)
  }

  unsubscribe(stream: string, handler: WsHandler) {
    this.handlers.get(stream)?.delete(handler)
    if (!this.handlers.get(stream)?.size) {
      this.handlers.delete(stream)
      this.streams.delete(stream)
    }
    if (this.streams.size === 0) {
      this.close()
    } else {
      this.reconnect()
    }
  }

  private reconnect() {
    this.close(false)
    if (!this.streams.size) return
    this.intentionalClose = false
    this.setStatus('connecting')
    const list = [...this.streams]
    const url =
      list.length === 1
        ? `${SPOT_WS}/${list[0]}`
        : `${SPOT_WS_COMBINED}?streams=${list.join('/')}`

    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => this.setStatus('live')
    ws.onclose = () => {
      this.setStatus('disconnected')
      if (!this.intentionalClose) {
        this.reconnectTimer = setTimeout(() => this.reconnect(), 2000)
      }
    }
    ws.onerror = () => {
      ws.close()
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string)
        if (msg.stream && msg.data) {
          this.dispatch(msg.stream, msg.data)
        } else {
          // single stream — need to infer from only stream
          const only = list[0]
          if (only) this.dispatch(only, msg)
        }
      } catch {
        /* ignore */
      }
    }
  }

  private dispatch(stream: string, data: unknown) {
    const set = this.handlers.get(stream)
    if (!set) return
    for (const h of set) h(data)
  }

  close(intentional = true) {
    this.intentionalClose = intentional
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
  }
}

export function parseWsTicker(raw: Record<string, string | number>): Ticker24h | null {
  const symbol = String(raw.s)
  if (!isTradeableUsdt(symbol)) return null
  return {
    symbol,
    base: baseFromSymbol(symbol),
    lastPrice: parseFloat(String(raw.c)),
    priceChange: parseFloat(String(raw.p)),
    priceChangePercent: parseFloat(String(raw.P)),
    highPrice: parseFloat(String(raw.h)),
    lowPrice: parseFloat(String(raw.l)),
    volume: parseFloat(String(raw.v)),
    quoteVolume: parseFloat(String(raw.q)),
    openPrice: parseFloat(String(raw.o)),
    weightedAvgPrice: parseFloat(String(raw.w)),
    count: parseInt(String(raw.n), 10),
    bidPrice: parseFloat(String(raw.b || '0')),
    askPrice: parseFloat(String(raw.a || '0')),
  }
}

export const miniTickerStream = '!miniTicker@arr'
export const allTickerStream = '!ticker@arr'

export function klineStream(symbol: string, interval: Interval) {
  return `${symbol.toLowerCase()}@kline_${interval}`
}

export function depthStream(symbol: string) {
  return `${symbol.toLowerCase()}@depth20@100ms`
}

export function bookTickerStream(symbol: string) {
  return `${symbol.toLowerCase()}@bookTicker`
}
