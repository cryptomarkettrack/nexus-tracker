#!/usr/bin/env node
/**
 * Capture NEXUS FOCUS structure (chart + watch zones + context) for
 * BTC/USDT and ETH/USDT and send screenshots to Telegram.
 *
 * Env (or .env.local):
 *   TELEGRAM_BOT_TOKEN   — from @BotFather
 *   TELEGRAM_CHAT_ID     — your user/group/channel id
 *   DASHBOARD_URL        — default http://127.0.0.1:4173 (vite preview)
 *   NOTIFY_INTERVAL      — chart TF: 4h | 1d | … (default 4h)
 *   NOTIFY_SYMBOLS       — comma list (default BTCUSDT,ETHUSDT)
 *   NOTIFY_AFTER_CLOSE_MS — ms after each 4h UTC close before capture (default 120000)
 *   START_PREVIEW        — "1" to auto-run `vite preview` if URL is local
 *   HEADLESS             — "0" to show browser (default 1)
 *
 * Usage:
 *   npm run notify:structure          # once
 *   npm run notify:structure:loop     # on each Binance 4h candle close (UTC)
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

loadEnvFiles([
  join(ROOT, '.env.local'),
  join(ROOT, '.env'),
])

const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run')
const BOT_TOKEN = DRY_RUN ? process.env.TELEGRAM_BOT_TOKEN?.trim() || '' : required('TELEGRAM_BOT_TOKEN')
const CHAT_ID = DRY_RUN ? process.env.TELEGRAM_CHAT_ID?.trim() || '' : required('TELEGRAM_CHAT_ID')
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'http://127.0.0.1:4173').replace(/\/$/, '')
const CHART_INTERVAL = process.env.NOTIFY_INTERVAL || '4h'
const SYMBOLS = (process.env.NOTIFY_SYMBOLS || 'BTCUSDT,ETHUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)
  .map((s) => (s.endsWith('USDT') ? s : `${s}USDT`))
const LOOP = process.argv.includes('--loop') || process.env.NOTIFY_LOOP === '1'
/** Binance 4h candles close on UTC multiples of 4h (00/04/08/12/16/20). */
const CANDLE_MS = 4 * 60 * 60 * 1000
/** Wait after close so the bar is sealed / APIs settled (default 2 min). */
const AFTER_CLOSE_MS = Number(process.env.NOTIFY_AFTER_CLOSE_MS ?? 120_000)
const HEADLESS = process.env.HEADLESS !== '0'
const START_PREVIEW = process.env.START_PREVIEW === '1' || process.argv.includes('--preview')
const OUT_DIR = join(ROOT, 'tmp', 'structure-shots')

function required(key) {
  const v = process.env[key]?.trim()
  if (!v) {
    console.error(`Missing ${key}. Copy .env.example → .env.local and fill Telegram credentials.`)
    process.exit(1)
  }
  return v
}

function loadEnvFiles(paths) {
  for (const p of paths) {
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq < 1) continue
      const k = t.slice(0, eq).trim()
      let v = t.slice(eq + 1).trim()
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1)
      }
      if (process.env[k] === undefined) process.env[k] = v
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Next wall-clock fire time: 4h UTC candle close + AFTER_CLOSE_MS.
 * Does not fire from process start — waits for the next boundary.
 */
function nextCandleCloseFireAt(now = Date.now()) {
  const period = CANDLE_MS
  const after = Number.isFinite(AFTER_CLOSE_MS) ? Math.max(0, AFTER_CLOSE_MS) : 120_000
  let close = Math.floor(now / period) * period
  let fire = close + after
  // If this close's fire window already passed, wait for the next close
  while (fire <= now) {
    close += period
    fire = close + after
  }
  return fire
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

async function waitUntilNextCandleClose() {
  const fireAt = nextCandleCloseFireAt()
  const waitMs = fireAt - Date.now()
  const closeAt = fireAt - (Number.isFinite(AFTER_CLOSE_MS) ? Math.max(0, AFTER_CLOSE_MS) : 120_000)
  console.log(
    `Next 4h candle close (UTC): ${new Date(closeAt).toISOString()} → capture at ${new Date(fireAt).toISOString()} (in ${formatDuration(waitMs)})`,
  )
  // Sleep in chunks so long waits stay accurate enough and process can be Ctrl+C'd cleanly
  while (Date.now() < fireAt) {
    const left = fireAt - Date.now()
    await sleep(Math.min(left, 30_000))
  }
}

function formatPrice(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (n >= 1) return n.toFixed(4).replace(/\.?0+$/, '')
  return n.toPrecision(4)
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.ok || res.status === 304) return
    } catch {
      /* retry */
    }
    await sleep(500)
  }
  throw new Error(`Dashboard not reachable at ${url} within ${timeoutMs}ms`)
}

async function ensurePreviewServer() {
  try {
    await waitForHttp(DASHBOARD_URL, 3_000)
    console.log(`Using existing server at ${DASHBOARD_URL}`)
    return null
  } catch {
    /* start one */
  }

  if (!START_PREVIEW && !isLocalUrl(DASHBOARD_URL)) {
    throw new Error(`Dashboard not reachable: ${DASHBOARD_URL}`)
  }

  // Always rebuild so snapshot deep-links match latest FOCUS UI
  console.log('Building production bundle…')
  await run('npm', ['run', 'build'], ROOT)

  console.log(`Starting vite preview → ${DASHBOARD_URL}`)
  const child = spawn(
    'npx',
    ['vite', 'preview', '--host', '127.0.0.1', '--port', portFromUrl(DASHBOARD_URL)],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  )
  child.stdout?.on('data', (d) => process.stdout.write(`[preview] ${d}`))
  child.stderr?.on('data', (d) => process.stderr.write(`[preview] ${d}`))
  await waitForHttp(DASHBOARD_URL, 90_000)
  return child
}

function isLocalUrl(url) {
  try {
    const u = new URL(url)
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  } catch {
    return false
  }
}

function portFromUrl(url) {
  try {
    const u = new URL(url)
    return u.port || (u.protocol === 'https:' ? '443' : '80')
  } catch {
    return '4173'
  }
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))
    })
    child.on('error', reject)
  })
}

function buildCaption(structure) {
  if (!structure) return 'NEXUS structure snapshot'
  const lines = []
  const pair = `${structure.base}/USDT`
  const chg =
    structure.change24h != null
      ? ` · ${fmtPct(structure.change24h)}`
      : ''
  lines.push(`◉ NEXUS · ${pair} · ${structure.interval}`)
  lines.push(`Price ${formatPrice(structure.price)}${chg}`)
  if (structure.setup) {
    lines.push(`Setup: ${structure.setup}${structure.setupReason ? ` — ${structure.setupReason}` : ''}`)
  }

  const zones = structure.watchZones ?? []
  if (zones.length) {
    lines.push('')
    lines.push('Watch zones')
    for (const z of zones.slice(0, 6)) {
      const band =
        z.high - z.low > z.mid * 0.0008
          ? `${formatPrice(z.low)}–${formatPrice(z.high)}`
          : formatPrice(z.mid)
      lines.push(
        `• ${z.label} (${z.side}) ${band} (${fmtPct(z.distancePct)}) [${(z.sources || []).slice(0, 4).join(', ')}]`,
      )
    }
  } else {
    lines.push('')
    lines.push('Watch zones: none nearby — mid-range')
  }

  if (structure.volumeProfile) {
    const vp = structure.volumeProfile
    lines.push('')
    lines.push(
      `Context · VAH ${formatPrice(vp.vah)} · POC ${formatPrice(vp.poc)} · VAL ${formatPrice(vp.val)}`,
    )
  }
  if (structure.rsi != null) {
    lines.push(
      `RSI ${Number(structure.rsi).toFixed(0)} · vol ${structure.volumeAnomaly != null ? `${Number(structure.volumeAnomaly).toFixed(2)}×` : '—'} · vs BTC ${fmtPct(structure.relStrengthBtc)}${structure.atrPct != null ? ` · ATR ${Number(structure.atrPct).toFixed(2)}%` : ''}`,
    )
  }
  if (structure.trendline && !structure.trendline.broken) {
    lines.push(
      `Peak TL @ ${formatPrice(structure.trendline.currentPrice)} (${fmtPct(structure.trendline.distancePct)})`,
    )
  }

  lines.push('')
  lines.push(new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC')
  // Telegram caption limit 1024
  return lines.join('\n').slice(0, 1000)
}

async function sendPhoto(buffer, caption) {
  const form = new FormData()
  form.append('chat_id', CHAT_ID)
  form.append('caption', caption)
  form.append('photo', new Blob([buffer], { type: 'image/png' }), 'structure.png')

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: form,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.ok) {
    throw new Error(`Telegram sendPhoto failed: ${res.status} ${JSON.stringify(json)}`)
  }
  return json
}

async function sendMessage(text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.ok) {
    throw new Error(`Telegram sendMessage failed: ${res.status} ${JSON.stringify(json)}`)
  }
}

async function captureSymbol(browser, symbol) {
  const url = `${DASHBOARD_URL}/?mode=focus&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(CHART_INTERVAL)}&snapshot=1`
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  })

  try {
    console.log(`  open ${symbol} → ${url}`)
    page.on('pageerror', (err) => console.error(`  [pageerror] ${err.message}`))
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error(`  [console] ${msg.text()}`)
    })
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90_000 })
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-focus-ready') === '1',
      null,
      { timeout: 90_000 },
    )
    // Extra frame for chart paint / zone overlays
    await sleep(1500)

    const structure = await page.evaluate(() => window.__NEXUS_STRUCTURE__ ?? null)
    const target = page.locator('[data-testid="focus-structure"]')
    const el = (await target.count()) ? target : page.locator('.mode-view--focus')
    const buffer = await el.screenshot({ type: 'png' })

    mkdirSync(OUT_DIR, { recursive: true })
    const file = join(OUT_DIR, `${symbol}-${CHART_INTERVAL}-${Date.now()}.png`)
    writeFileSync(file, buffer)
    console.log(`  saved ${file} (${buffer.length} bytes)`)

    const caption = buildCaption(structure)
    if (DRY_RUN) {
      console.log(`  dry-run caption:\n${caption}\n`)
      console.log(`  (skip Telegram)`)
      return { symbol, ok: true, dryRun: true }
    }
    await sendPhoto(buffer, caption)
    console.log(`  sent ${symbol} to Telegram`)
    return { symbol, ok: true }
  } finally {
    await page.close().catch(() => {})
  }
}

async function runOnce(browser) {
  console.log(`\nNEXUS structure notify · ${new Date().toISOString()}`)
  console.log(`pairs: ${SYMBOLS.join(', ')} · tf: ${CHART_INTERVAL}`)
  const results = []
  for (const symbol of SYMBOLS) {
    try {
      results.push(await captureSymbol(browser, symbol))
    } catch (e) {
      console.error(`  FAIL ${symbol}:`, e instanceof Error ? e.message : e)
      results.push({ symbol, ok: false, error: String(e) })
      try {
        await sendMessage(
          `⚠ NEXUS structure capture failed for ${symbol}: ${e instanceof Error ? e.message : e}`,
        )
      } catch {
        /* ignore secondary failure */
      }
    }
  }
  return results
}

async function main() {
  let preview = null
  try {
    if (START_PREVIEW || isLocalUrl(DASHBOARD_URL)) {
      preview = await ensurePreviewServer()
    } else {
      await waitForHttp(DASHBOARD_URL, 15_000)
    }

    const browser = await chromium.launch({ headless: HEADLESS })
    try {
      if (LOOP) {
        console.log(
          `Loop on Binance 4h candle close (UTC 00/04/08/12/16/20 + ${AFTER_CLOSE_MS}ms). Ctrl+C to stop.`,
        )
        // Wait for next close — do not run from process start
        for (;;) {
          await waitUntilNextCandleClose()
          await runOnce(browser)
        }
      } else {
        await runOnce(browser)
      }
    } finally {
      await browser.close()
    }
  } finally {
    if (preview) {
      preview.kill('SIGTERM')
    }
  }
}

// Optional: tiny self-test that port is free helper is unused — keep main clean
void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
