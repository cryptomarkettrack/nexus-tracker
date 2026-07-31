# NEXUS — Market Intelligence Terminal

An advanced crypto dashboard built for **reading the market**, not watching a price ticker.

## Modes

| Mode | Purpose |
|------|---------|
| **COMMAND** | Market regime, breadth, sector rotation, funding extremes, near S/R levels, scored setups |
| **SCANNER** | Opportunity matrix — breakouts, volume spikes, relative strength vs BTC, mean reversion, squeezes |
| **RADAR** | Return heatmap + sector board + alpha leaders/laggards |
| **FOCUS** | Per-coin deep dive: multi-TF chart with S/R, volume profile (POC/VAH/VAL), order book imbalance, ATR targets |

## Data

- **Binance Spot REST** — 24h tickers, klines, order book
- **Binance Spot WebSocket** — live `!ticker@arr` stream
- **Binance USDT-M Futures** — funding / mark price (`premiumIndex`)
- **Local engines** — swing S/R clustering, volume profile, RSI/ATR, setup scoring, regime detection

No API keys required for public market data.

## Run

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## How to use it

1. Start on **COMMAND** — read regime + breadth before picking risk.
2. Jump to **SCANNER** when hunting entries (filter by setup type).
3. Use **RADAR** for sector rotation and which names lead/lag BTC.
4. Click any coin → **FOCUS** for levels, volume nodes, book pressure, and ATR targets.

## Stack

Vite · React 19 · TypeScript · Zustand · lightweight-charts · Binance public APIs
