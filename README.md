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

## Telegram structure alerts (every 4h)

Sends a **screenshot of FOCUS** (chart + watch zones + context) for **BTC/USDT** and **ETH/USDT**, with a text caption summarizing levels and profile.

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Open a chat with the bot (or add it to a group) and send any message.
3. Resolve your chat id:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
   ```
4. Copy env template and fill credentials:
   ```bash
   cp .env.example .env.local
   ```

### Run once

```bash
npm install
npx playwright install chromium
npm run notify:structure
```

This builds/serves the app if needed, screenshots each pair, and posts to Telegram.

### Every 4 hours

**Option A — long-running process (aligns to 4h candle close, UTC)**

```bash
npm run notify:structure:loop
```

Waits for the next Binance 4h close (`00/04/08/12/16/20` UTC), then captures ~2 minutes after close. Does **not** fire when you start the command.

**Option B — cron (macOS / Linux)**

```cron
0 */4 * * * cd /path/to/crypto-dashboard-grok && /usr/local/bin/npm run notify:structure >> /tmp/nexus-notify.log 2>&1
```

**Option C — launchd (macOS)** — create `~/Library/LaunchAgents/com.nexus.structure-notify.plist` with a `StartInterval` of `14400` and `ProgramArguments` invoking `npm run notify:structure` in this project directory.

### Deep link (manual)

```
http://localhost:5173/?mode=focus&symbol=BTCUSDT&interval=4h&snapshot=1
```

`snapshot=1` hides the trade desk and search chrome for a clean structure capture.

Optional env: `NOTIFY_INTERVAL` (chart TF, default `4h`), `NOTIFY_SYMBOLS`, `DASHBOARD_URL`.

## Stack

Vite · React 19 · TypeScript · Zustand · lightweight-charts · Binance public APIs · Playwright (Telegram shots)
