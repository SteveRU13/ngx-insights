/**
 * NGX INSIGHTS — Live Price Scraper (Puppeteer Edition)
 * ======================================================
 * NGX loads prices via JavaScript after page load.
 * This scraper uses a headless Chrome browser (Puppeteer)
 * to wait for the JS to execute before extracting data.
 *
 * INSTALL:
 *   npm install
 *
 * RUN:
 *   node scraper.js
 *
 * API runs at http://localhost:4000
 */

const puppeteer = require('puppeteer');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 4000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'REMOVED';
const NGX_URL = 'https://ngxgroup.com/exchange/data/equities-price-list/';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── STATE ────────────────────────────────────────────────
let cache = {
  stocks: [],
  asi: null,
  lastUpdated: null,
  status: 'idle',
  error: null,
};

// ─── MAIN SCRAPER ─────────────────────────────────────────
async function scrapeNGX() {
  console.log(`[${new Date().toISOString()}] Scraping NGX prices...`);
  cache.status = 'fetching';

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      timeout: 60000,
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    // Strategy: The NGX website embeds ALL stock prices in the page as a
    // scrolling ticker tape (visible on every page). This is rendered server-side
    // in the HTML so it loads instantly — much more reliable than the JS table.
    console.log('  Loading NGX page...');
    await page.goto(NGX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));

    const result = await page.evaluate(() => {
      const parseNum = (str) => {
        if (!str) return 0;
        const n = parseFloat(str.replace(/[₦N,\s]/g, '').replace(/[^0-9.-]/g, ''));
        return isNaN(n) ? 0 : n;
      };

      // ── Strategy 1: Ticker tape elements ──────────────────────────────
      // NGX ticker tape typically uses spans/divs with class names like
      // 'ticker-item', 'stock-ticker', 'market-ticker' etc.
      // The ticker tape text pattern is: "SYMBOL Nprice change%"
      const stocks = [];
      const seen = new Set();

      // Try to find ticker tape container
      const tickerSelectors = [
        '.ticker-tape', '.market-ticker', '.stock-ticker', '.ticker',
        '[class*="ticker"]', '[class*="marquee"]', '[id*="ticker"]',
        '.price-ticker', '.equity-ticker',
      ];

      let tickerText = '';
      for (const sel of tickerSelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText && el.innerText.length > 100) {
          tickerText = el.innerText;
          break;
        }
      }

      // If no specific ticker element, grab full page text and find the ticker section
      if (!tickerText) {
        tickerText = document.body.innerText;
      }

      // Parse ticker format: "ACCESSCORP N26.20-0.30 %" or "MTNN N790.00 -5.00 %"
      // Pattern: WORD(s) N(number)(sign)(number) %
      const tickerPattern = /([A-Z][A-Z0-9\s.\[\]]+?)\s+N([\d,.]+)\s*([-+]?[\d,.]+)\s*%/g;
      let match;
      while ((match = tickerPattern.exec(tickerText)) !== null) {
        const rawName = match[1].trim();
        const price = parseNum(match[2]);
        const change = parseNum(match[3]);

        if (!rawName || price <= 0 || seen.has(rawName)) continue;
        if (rawName.length < 2 || rawName.length > 30) continue;
        // Skip bond/note entries (all caps letters + numbers + specific patterns)
        if (/^(LAB|LFZ|BUA|ABC|ADV|AXA|BAU|CIL|CMB|CNIF|MCI|CEMC|LOTUSHAL|MOFIREIF)\d/.test(rawName)) continue;

        seen.add(rawName);
        const changePct = price > 0 ? parseFloat(((change / (price - change)) * 100).toFixed(2)) : 0;

        stocks.push({ name: rawName, close: price, change, changePct });
      }

      // ── Strategy 2: If ticker parsing got < 20 stocks, try the table ──
      if (stocks.length < 20) {
        const tables = Array.from(document.querySelectorAll('table'));
        const bigTable = tables.reduce((best, t) => {
          const r = t.querySelectorAll('tbody tr').length;
          return r > (best ? best.querySelectorAll('tbody tr').length : 0) ? t : best;
        }, null);

        if (bigTable) {
          const rows = bigTable.querySelectorAll('tbody tr');
          rows.forEach(row => {
            const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
            if (cells.length < 5) return;
            const name = cells[0];
            if (!name || seen.has(name)) return;
            const prevClose = parseNum(cells[1]);
            const open = parseNum(cells[2]);
            const high = parseNum(cells[3]);
            const low = parseNum(cells[4]);
            const close = parseNum(cells[5]) || parseNum(cells[4]);
            const change = parseNum(cells[6]);
            if (!close || close <= 0) return;
            const base = prevClose || open || close;
            const changePct = base > 0 ? parseFloat(((change / base) * 100).toFixed(2)) : 0;
            seen.add(name);
            stocks.push({ name, close, open, high, low, change, changePct, prevClose,
              volume: parseNum(cells[7]) });
          });
        }
      }

      // ── ASI value ──────────────────────────────────────────────────────
      let asi = null;
      const bodyText = document.body.innerText;
      for (const pat of [/All.Share[^\d]*([\d,]+\.?\d*)/i, /ASI[^\d]*([\d,]+\.?\d*)/i]) {
        const m = bodyText.match(pat);
        if (m) {
          const v = parseFloat(m[1].replace(/,/g, ''));
          if (v > 50000 && v < 2000000) { asi = v; break; }
        }
      }

      return { stocks, asi, count: stocks.length };
    });

    await browser.close();
    browser = null;

    if (result.stocks.length === 0) {
      throw new Error('Parsed 0 stocks — page structure may have changed');
    }

    const stocks = result.stocks.map(s => ({
      ticker: resolveTicker(s.name),
      name: cleanName(s.name),
      sector: 'NGX',
      open: s.open || s.close,
      high: s.high || s.close,
      low: s.low || s.close,
      close: s.close,
      change: s.change,
      changePct: s.changePct,
      volume: s.volume || 0,
      timestamp: new Date().toISOString(),
    }));

    cache = {
      stocks,
      asi: result.asi ? { value: result.asi } : null,
      lastUpdated: new Date().toISOString(),
      status: 'ok',
      error: null,
    };

    console.log(`[OK] Scraped ${stocks.length} stocks. ASI: ${result.asi || 'not found'}`);
    if (stocks.length > 0) {
      const s = stocks.find(s => s.changePct !== 0) || stocks[0];
      console.log(`  Sample: ${s.ticker} @ ₦${s.close} (${s.changePct >= 0 ? '+' : ''}${s.changePct}%)`);
    }

    return cache;

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(`[ERROR] Scrape failed: ${err.message}`);
    cache.status = 'error';
    cache.error = err.message;
    throw err;
  }
}

// ─── TICKER RESOLUTION ────────────────────────────────────
const TICKER_MAP = {
  'dangote cement': 'DANGCEM',
  'dangote sugar': 'DANGSUGAR',
  'dangote industries': 'DANGOTE',
  'guaranty trust': 'GTCO',
  'gtco': 'GTCO',
  'gtbank': 'GTCO',
  'zenith bank': 'ZENITHBANK',
  'mtn nigeria': 'MTNN',
  'airtel africa': 'AIRTELAFRI',
  'nestle nigeria': 'NESTLE',
  'fbn holdings': 'FBNH',
  'first bank': 'FBNH',
  'seplat energy': 'SEPLAT',
  'seplat petroleum': 'SEPLAT',
  'bua cement': 'BUACEMENT',
  'bua foods': 'BUAFOODS',
  'access holdings': 'ACCESSCORP',
  'access bank': 'ACCESSCORP',
  'stanbic ibtc': 'STANBIC',
  'wema bank': 'WEMABANK',
  'sterling bank': 'STERLNBANK',
  'sterling financial': 'STERLNBANK',
  'united bank for africa': 'UBA',
  'uba': 'UBA',
  'international breweries': 'INTBREW',
  'nigerian breweries': 'NB',
  'unilever nigeria': 'UNILEVER',
  'total energies': 'TOTAL',
  'total nigeria': 'TOTAL',
  'ardova': 'ARDOVA',
  'lafarge africa': 'LAFARGE',
  'julius berger': 'JBERGER',
  'cadbury nigeria': 'CADBURY',
  'flour mills': 'FLOURMILL',
  'honeywell flour': 'HONYFLOUR',
  'presco': 'PRESCO',
  'okomu oil': 'OKOMUOIL',
  'conoil': 'CONOIL',
  'ecobank': 'ETI',
  'ecobank transnational': 'ETI',
  'fidelity bank': 'FIDELITYBK',
  'jaiz bank': 'JAIZBANK',
  'union bank': 'UBN',
  'unity bank': 'UNITYBNK',
  'fcmb group': 'FCMB',
  'first city monument': 'FCMB',
  'coronation insurance': 'CORONATION',
  'custodian investment': 'CUSTODIAN',
  'aiico insurance': 'AIICO',
  'mansard insurance': 'MANSARD',
  'mutual benefits': 'MUTUAL',
  'seven-up bottling': 'SEVUP',
  'seven up': 'SEVUP',
  'vita foam': 'VITAFOAM',
  'champion breweries': 'CHAMPION',
  'portland paints': 'PORTPAINT',
  'berger paints': 'BERGER',
  'meyer': 'MEYER',
  'cutix': 'CUTIX',
  'caverton offshore': 'CAVERTON',
  'caverton': 'CAVERTON',
  'chams holding': 'CHAMS',
  'computer warehouse': 'CWG',
  'transcorp hotels': 'TRANSCOHOT',
  'transcorp': 'TRANSCORP',
  'uacn': 'UACN',
  'wapco': 'WAPCO',
  'cement company': 'CCNN',
  'nascon': 'NASCON',
  'red star': 'REDSTAREX',
  'omatek': 'OMATEK',
  'e-tranzact': 'ETRANZACT',
  'ncr nigeria': 'NCR',
  'ab': 'AB',
};

function resolveTicker(name) {
  const lower = name.toLowerCase();
  for (const [key, ticker] of Object.entries(TICKER_MAP)) {
    if (lower.includes(key)) return ticker;
  }
  // Generic: take first meaningful word(s)
  return name
    .toUpperCase()
    .replace(/\bPLC\b|\bLIMITED\b|\bLTD\b|\bNIGERIA\b|\bGROUP\b/g, '')
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10) || 'UNKNOWN';
}

function cleanName(name) {
  return name.replace(/\s+/g, ' ').replace(/\bPLC\b/gi, 'Plc').trim();
}

function cleanSector(sector) {
  const map = {
    'banking': 'Banking', 'bank': 'Banking',
    'consumer goods': 'Consumer Goods', 'consumer staples': 'Consumer Goods',
    'oil and gas': 'Oil & Gas', 'oil & gas': 'Oil & Gas', 'petroleum': 'Oil & Gas',
    'telecommunications': 'Telecoms', 'telecom': 'Telecoms', 'ict': 'Telecoms',
    'industrial goods': 'Industrial', 'industrial': 'Industrial', 'cement': 'Industrial',
    'conglomerates': 'Conglomerates',
    'healthcare': 'Healthcare', 'pharmaceutical': 'Healthcare',
    'insurance': 'Insurance',
    'financial services': 'Financial Services',
    'agriculture': 'Agriculture', 'agro': 'Agriculture',
    'construction': 'Construction', 'real estate': 'Real Estate',
  };
  const lower = (sector || '').toLowerCase().trim();
  for (const [key, val] of Object.entries(map)) {
    if (lower.includes(key)) return val;
  }
  return sector || 'Other';
}

// ─── HELPERS ──────────────────────────────────────────────
function isCacheValid() {
  if (!cache.lastUpdated || cache.stocks.length === 0) return false;
  return Date.now() - new Date(cache.lastUpdated).getTime() < CACHE_TTL_MS;
}

function isMarketHours() {
  const now = new Date();
  const wat = new Date(now.getTime() + 60 * 60 * 1000); // UTC+1
  const h = wat.getUTCHours(), m = wat.getUTCMinutes(), d = now.getUTCDay();
  return d >= 1 && d <= 5 && (h > 10 || (h === 10 && m >= 0)) && (h < 14 || (h === 14 && m <= 30));
}

// ─── API ROUTES ───────────────────────────────────────────

app.get('/api/prices', async (req, res) => {
  try {
    if (!isCacheValid()) await scrapeNGX();
    res.json({
      status: cache.status,
      lastUpdated: cache.lastUpdated,
      marketOpen: isMarketHours(),
      count: cache.stocks.length,
      stocks: cache.stocks,
    });
  } catch (err) {
    res.json({
      status: 'error', error: err.message,
      lastUpdated: cache.lastUpdated, marketOpen: false,
      count: cache.stocks.length, stocks: cache.stocks, stale: true,
    });
  }
});

app.get('/api/prices/:ticker', async (req, res) => {
  if (!isCacheValid()) await scrapeNGX().catch(() => {});
  const stock = cache.stocks.find(s => s.ticker === req.params.ticker.toUpperCase());
  if (!stock) return res.status(404).json({ error: `${req.params.ticker} not found` });
  res.json(stock);
});

app.get('/api/market', async (req, res) => {
  if (!isCacheValid()) await scrapeNGX().catch(() => {});
  res.json({
    asi: cache.asi,
    advances: cache.stocks.filter(s => s.changePct > 0).length,
    declines: cache.stocks.filter(s => s.changePct < 0).length,
    unchanged: cache.stocks.filter(s => s.changePct === 0).length,
    totalVolume: cache.stocks.reduce((sum, s) => sum + (s.volume || 0), 0),
    totalStocks: cache.stocks.length,
    marketOpen: isMarketHours(),
    lastUpdated: cache.lastUpdated,
    status: cache.status,
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: cache.status, lastUpdated: cache.lastUpdated,
    stockCount: cache.stocks.length, cacheValid: isCacheValid(),
    marketOpen: isMarketHours(), error: cache.error, uptime: process.uptime(),
  });
});

app.post('/api/refresh', async (req, res) => {
  try {
    await scrapeNGX();
    res.json({ success: true, count: cache.stocks.length, lastUpdated: cache.lastUpdated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── AI PROXY ─────────────────────────────────────────────
// Proxies Anthropic API calls from the browser to avoid CORS
app.post('/api/ai', async (req, res) => {
  const apiKey = ANTHROPIC_API_KEY || req.headers['x-api-key'];
  if (!apiKey) return res.status(500).json({ error: 'API key not configured on server' });

  try {
    const https = require('https');
    const body = JSON.stringify(req.body);
    let data = '';

    const proxyReq = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (proxyRes) => {
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        res.status(proxyRes.statusCode)
           .set('Content-Type', 'application/json')
           .send(data);
      });
    });

    proxyReq.on('error', (e) => res.status(500).json({ error: e.message }));
    proxyReq.write(body);
    proxyReq.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SCHEDULED REFRESH ────────────────────────────────────
// Every 10 mins during market hours (WAT = UTC+1)
cron.schedule('*/10 9-14 * * 1-5', () => {
  scrapeNGX().catch(err => console.error('Scheduled scrape failed:', err.message));
}, { timezone: 'UTC' });

// EOD snapshot at 3:30pm WAT
cron.schedule('30 14 * * 1-5', () => {
  scrapeNGX().catch(err => console.error('EOD scrape failed:', err.message));
}, { timezone: 'UTC' });

// ─── START ────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║    NGX Insights — Live Price Scraper     ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  API:  http://localhost:${PORT}              ║`);
  console.log('║  Mode: Headless Chrome (Puppeteer)       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('Performing initial data fetch...');
  console.log('(First run downloads Chromium ~170MB — one time only)');
  console.log('');

  try {
    await scrapeNGX();
    console.log(`\n✅ Ready — ${cache.stocks.length} stocks loaded`);
    console.log(`   Open index.html in your browser`);
  } catch (err) {
    console.warn(`\n⚠️  Initial fetch failed: ${err.message}`);
    console.warn('   App still works with demo data.');
    console.warn('   Visit http://localhost:4000/api/refresh to retry.');
  }
});
