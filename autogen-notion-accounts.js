'use strict';

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const http = require('http');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const { SocksClient } = require('socks');

// Dynamic proxy agent loaders (same as use.ai)
let _SPA, _HPA, _HSPA;
async function loadSPA() {
  if (!_SPA) { const m = await import('socks-proxy-agent'); _SPA = m.SocksProxyAgent; }
  return _SPA;
}
async function loadHPA() {
  if (!_HPA) { const m = await import('http-proxy-agent'); _HPA = m.HttpProxyAgent; }
  return _HPA;
}
async function loadHSPA() {
  if (!_HSPA) { const m = await import('https-proxy-agent'); _HSPA = m.HttpsProxyAgent; }
  return _HSPA;
}

puppeteer.use(StealthPlugin());

// ── Config ──────────────────────────────────────────────────────────────────
const TOKENS_FILE = path.join(__dirname, 'notion-tokens.txt');
const POOL_STATE_FILE = path.join(__dirname, 'notion-pool.json');
const PROXIES_FILE = path.join(__dirname, 'proxies.txt');
const PROXY_HEALTH_FILE = path.join(__dirname, 'notion-proxy-health.json');

const TARGET_POOL_SIZE = 20;          // desired number of ready tokens
const MIN_POOL_SIZE = 8;              // refill threshold
const MAX_CONCURRENT_FILLS = 3;       // background fills
const BATCH_SIZE = 5;                 // accounts per fill batch
const DELAY_BETWEEN_ACCOUNTS = 10_000; // 10s between creations (per proxy)
const PROXY_REFRESH_MS = 15 * 60 * 1000;

const PROXIFLY_URL = 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt';
const PROXYSCRAPE_URL = 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&timeout=5000&status=alive';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0';

// ── Proxy Management (adapted from use.ai) ─────────────────────────────────
let cachedProxies = [];
let proxiesLoaded = false;
let refreshRunning = false;
let refreshPromise = null;
const provenProxies = [];
const provenProxiesSet = new Set();
const proxyHealth = new Map();

function parseProxyLines(txt) {
  return txt.split('\n').map(l => l.trim()).filter(l => l && (l.startsWith('socks') || l.startsWith('http')));
}

function loadProxies() {
  if (proxiesLoaded) return;
  proxiesLoaded = true;

  try {
    const txt = fs.readFileSync(PROXIES_FILE, 'utf-8');
    const list = parseProxyLines(txt);
    if (list.length) cachedProxies = list;
  } catch {}

  if (!cachedProxies.length) {
    refreshProxies().catch(() => {});
  }
}

function getHealth(proxy) {
  let h = proxyHealth.get(proxy);
  if (!h) {
    if (proxyHealth.size >= 1000) {
      const oldestKey = proxyHealth.keys().next().value;
      if (oldestKey) proxyHealth.delete(oldestKey);
    }
    h = { ok: 0, fail: 0, lastOk: 0, blocked: false, coolingUntil: 0, inUse: 0 };
    proxyHealth.set(proxy, h);
  }
  return h;
}

function recordProxyResult(proxy, success) {
  if (!proxy) return;
  const h = getHealth(proxy);
  if (success) {
    h.ok++; h.lastOk = Date.now(); h.blocked = false; h.coolingUntil = 0;
    if (!provenProxiesSet.has(proxy)) {
      provenProxies.push(proxy);
      provenProxiesSet.add(proxy);
    }
  } else {
    h.fail++;
    if (h.fail >= 2 || h.blocked) {
      h.blocked = true;
      const idx = provenProxies.indexOf(proxy);
      if (idx !== -1) {
        provenProxies.splice(idx, 1);
        provenProxiesSet.delete(proxy);
      }
    }
  }
  persistProxyHealthAsync();
}

function markProxyBlocked(proxy) {
  if (!proxy) return;
  const h = getHealth(proxy);
  h.blocked = true;
  const idx = provenProxies.indexOf(proxy);
  if (idx !== -1) {
    provenProxies.splice(idx, 1);
    provenProxiesSet.delete(proxy);
  }
  persistProxyHealthAsync();
}

function cooldownProxy(proxy, ms) {
  if (!proxy) return;
  const h = getHealth(proxy);
  h.coolingUntil = Math.max(h.coolingUntil, Date.now() + ms);
  persistProxyHealthAsync();
}

function acquireProxy(proxy) { getHealth(proxy).inUse++; }
function releaseProxy(proxy) { const h = getHealth(proxy); if (h.inUse > 0) h.inUse--; }

let proxyHealthWriteTimer = null;
function persistProxyHealthAsync() {
  clearTimeout(proxyHealthWriteTimer);
  proxyHealthWriteTimer = setTimeout(async () => {
    try {
      const health = {};
      for (const [proxy, h] of proxyHealth) {
        if (h.ok === 0 && h.fail === 0 && !h.blocked && !h.coolingUntil) continue;
        health[proxy] = { ok: h.ok, fail: h.fail, lastOk: h.lastOk, blocked: h.blocked, coolingUntil: h.coolingUntil };
      }
      await fsPromises.writeFile(PROXY_HEALTH_FILE, JSON.stringify({ proven: provenProxies.slice(0, 500), health }), 'utf-8');
    } catch {}
  }, 500);
}

function loadProxyHealth() {
  try {
    const raw = fs.readFileSync(PROXY_HEALTH_FILE, 'utf-8');
    const state = JSON.parse(raw);
    const health = state.health || {};
    for (const proxy of Object.keys(health)) {
      const h = health[proxy];
      proxyHealth.set(proxy, {
        ok: h.ok || 0, fail: h.fail || 0, lastOk: h.lastOk || 0,
        blocked: !!h.blocked, coolingUntil: h.coolingUntil || 0, inUse: 0,
      });
    }
    if (Array.isArray(state.proven)) {
      for (const p of state.proven) {
        if (typeof p === 'string' && !provenProxiesSet.has(p)) {
          provenProxies.push(p);
          provenProxiesSet.add(p);
        }
      }
    }
  } catch {}
}

async function fetchUrl(url, label) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': USER_AGENT }, timeout: 15000 }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve(buf));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error(`${label} timeout`)); });
  });
}

async function fetchProxyList() {
  const sources = [
    { url: PROXIFLY_URL, label: 'proxifly' },
    { url: PROXYSCRAPE_URL, label: 'proxyscrape' },
  ];
  for (const src of sources) {
    try {
      const raw = await fetchUrl(src.url, src.label);
      const lines = parseProxyLines(raw);
      if (lines.length) return lines;
    } catch {}
  }
  return [];
}

async function refreshProxies() {
  if (refreshRunning) return refreshPromise;
  refreshRunning = true;
  refreshPromise = (async () => {
    try {
      const lines = await fetchProxyList();
      if (!lines.length) return;
      try { await fsPromises.writeFile(PROXIES_FILE, lines.join('\n') + '\n', 'utf-8'); } catch {}
      cachedProxies = lines;
      proxiesLoaded = true;
    } catch {} finally {
      refreshRunning = false;
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

const MAX_PROXY_CONCURRENT = 2;

function pickProxy() {
  loadProxies();
  const now = Date.now();

  if (provenProxies.length) {
    const shuffled = provenProxies.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (const p of shuffled) {
      const h = proxyHealth.get(p);
      if (!h) return p;
      if (h.blocked || h.coolingUntil > now || h.inUse >= MAX_PROXY_CONCURRENT) continue;
      return p;
    }
    const usable = shuffled.filter(p => !proxyHealth.get(p)?.blocked);
    if (usable.length > 0) {
      return usable.sort((a, b) => (proxyHealth.get(a)?.inUse || 0) - (proxyHealth.get(b)?.inUse || 0))[0];
    }
  }

  if (!cachedProxies.length) return undefined;
  for (let i = 0; i < 30; i++) {
    const p = cachedProxies[Math.floor(Math.random() * cachedProxies.length)];
    const h = proxyHealth.get(p);
    if (!h) return p;
    if (h.blocked || h.coolingUntil > now) continue;
    return p;
  }
  return cachedProxies[Math.floor(Math.random() * cachedProxies.length)];
}

// ── HTTP with proxy (for API calls) ────────────────────────────────────────
async function fetchWithProxy(url, options = {}, proxy) {
  let agent;
  if (proxy) {
    if (proxy.startsWith('socks4') || proxy.startsWith('socks5')) {
      const Agent = await loadSPA();
      agent = new Agent(proxy);
    } else {
      const urlObj = new URL(url);
      if (urlObj.protocol === 'https:') {
        const Agent = await loadHSPA();
        agent = new Agent(proxy);
      } else {
        const Agent = await loadHPA();
        agent = new Agent(proxy);
      }
    }
  }

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const req = (isHttps ? https : http).request({
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers,
      agent,
      rejectUnauthorized: false,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── Mail.tm API (with proxy) ───────────────────────────────────────────────
async function requestJSON(url, options = {}, bodyData = null, proxy = null) {
  const headers = { 'User-Agent': USER_AGENT, ...(options.headers || {}) };
  let bodyString = bodyData ? JSON.stringify(bodyData) : null;
  if (bodyString) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(bodyString);
  }
  return fetchWithProxy(url, { method: options.method || (bodyData ? 'POST' : 'GET'), headers, body: bodyString }, proxy);
}

async function createTempMailbox(proxy) {
  const domains = await requestJSON('https://api.mail.tm/domains', {}, null, proxy);
  if (!domains['hydra:member'] || !domains['hydra:member'].length) {
    throw new Error('No domains available from Mail.tm');
  }
  const domain = domains['hydra:member'][0].domain;
  const username = 'bot_' + Math.random().toString(36).substring(2, 10);
  const email = `${username}@${domain}`;
  const password = 'Password_' + Math.random().toString(36).substring(2, 10);

  await requestJSON('https://api.mail.tm/accounts', {}, { address: email, password }, proxy);
  const tokenRes = await requestJSON('https://api.mail.tm/token', {}, { address: email, password }, proxy);
  return { email, authToken: tokenRes.token };
}

async function waitForNotionCode(authToken, proxy) {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const msgs = await requestJSON('https://api.mail.tm/messages', {
      headers: { 'Authorization': `Bearer ${authToken}` }
    }, null, proxy);

    const list = msgs['hydra:member'] || [];
    if (list.length > 0) {
      const detail = await requestJSON(`https://api.mail.tm/messages/${list[0].id}`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      }, null, proxy);
      const text = detail.text || (typeof detail.html === 'string' ? detail.html : detail.html?.[0]) || '';
      const match = text.match(/\b\d{6}\b/);
      if (match) return match[0];
    }
  }
  throw new Error('Verification code timed out');
}

// ── Notion Account Creation (with proxy) ──────────────────────────────────
async function createAccountWithWorkspace(proxy) {
  const { email, authToken } = await createTempMailbox(proxy);
  console.log(`[1/5] Temp Email Created: ${email} (via ${proxy})`);

  // Configure Puppeteer with proxy
  const browserArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--headless=new',
    '--window-size=1280,800'
  ];
  if (proxy) {
    browserArgs.push(`--proxy-server=${proxy}`);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: browserArgs
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  try {
    await page.goto('https://www.notion.so/signup', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('input[type="email"]', { timeout: 15000 });
    await page.type('input[type="email"]', email, { delay: 30 });
    await page.keyboard.press('Enter');
    console.log(`[2/5] Submitted email... waiting for code...`);

    const code = await waitForNotionCode(authToken, proxy);
    console.log(`[3/5] Received Code: ${code}`);

    await page.waitForSelector('input[placeholder*="code"]', { timeout: 15000 }).catch(() => {});
    await page.keyboard.type(code, { delay: 30 });
    await page.keyboard.press('Enter');

    console.log(`[4/5] Code submitted. Initializing API-driven onboarding bypass...`);

    let verification = null;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    for (let attempt = 1; attempt <= 15; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      const url = page.url();
      console.log(`[BOT] Current URL: ${url} (Attempt ${attempt}/15)`);

      verification = await page.evaluate(async () => {
        try {
          const spacesRes = await fetch('/api/v3/getSpaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          if (!spacesRes.ok) {
            return { success: false, reason: `getSpaces responded with status ${spacesRes.status}` };
          }
          const spacesData = await spacesRes.json();
          const userId = spacesData.notion_user ? Object.keys(spacesData.notion_user)[0] : null;
          let spaceId = spacesData.space ? Object.keys(spacesData.space)[0] : null;

          if (!userId || !uuidRegex.test(userId)) {
            return { success: false, reason: 'Waiting for valid user session...' };
          }
          if (spaceId && uuidRegex.test(spaceId)) {
            return { success: true, spaceId: spaceId, userId: userId };
          }

          const createRes = await fetch('/api/v3/createSpace', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-notion-active-user-header': userId },
            body: JSON.stringify({ name: "My Workspace", planType: "personal" })
          });
          if (createRes.status === 429) {
            return { success: false, reason: 'Rate limited (429) by Notion' };
          }
          if (!createRes.ok) {
            return { success: false, reason: `createSpace responded with status ${createRes.status}` };
          }
          const createData = await createRes.json();
          const newSpaceId = createData.spaceId || (createData.recordMap?.space ? Object.keys(createData.recordMap.space)[0] : null);
          if (newSpaceId && uuidRegex.test(newSpaceId)) {
            return { success: true, spaceId: newSpaceId, userId: userId };
          }
          return { success: false, reason: 'Failed to extract spaceId from createSpace response' };
        } catch (err) {
          return { success: false, reason: err.message };
        }
      });

      if (verification && verification.success) {
        console.log(`[BOT] Workspace successfully verified/created via backend API: Space ID ${verification.spaceId}`);
        break;
      } else {
        console.log(`[BOT] Pending workspace resolution: ${verification ? verification.reason : 'No response'}`);
      }
    }

    if (!verification || !verification.success) {
      throw new Error(`Workspace bypass failed: ${verification ? verification.reason : 'Timeout'}`);
    }

    const cookies = await page.cookies();
    const tokenCookie = cookies.find(c => c.name === 'token_v2');
    if (!tokenCookie) throw new Error('token_v2 cookie not found');

    const cleanToken = decodeURIComponent(tokenCookie.value);
    console.log(`[5/5] SUCCESS! Token verified with Space ID: ${verification.spaceId}`);
    await browser.close();
    return cleanToken;
  } catch (err) {
    try { await browser.close(); } catch {}
    throw err;
  }
}

// ── Account Pool (Notion tokens) ────────────────────────────────────────────
let pool = [];
let fillInProgress = 0;
let fillPromise = null;
let warmed = false;
let fillStats = { attempts: 0, successes: 0, failures: 0 };

function persistPoolAsync() {
  // Debounced writing to file
  if (persistPoolAsync.timer) return;
  persistPoolAsync.timer = setTimeout(async () => {
    persistPoolAsync.timer = null;
    try {
      await fsPromises.writeFile(POOL_STATE_FILE, JSON.stringify(pool, null, 2), 'utf-8');
    } catch {}
  }, 2000);
}

function loadPool() {
  try {
    const raw = fs.readFileSync(POOL_STATE_FILE, 'utf-8');
    pool = JSON.parse(raw);
    if (!Array.isArray(pool)) pool = [];
  } catch {}
}

async function fillPool() {
  if (fillInProgress >= MAX_CONCURRENT_FILLS) return;
  const room = TARGET_POOL_SIZE - pool.length;
  if (room <= 0) return;
  const threads = Math.min(MAX_CONCURRENT_FILLS - fillInProgress, Math.ceil(room / BATCH_SIZE));
  const promises = [];
  for (let t = 0; t < threads; t++) {
    fillInProgress++;
    const p = (async () => {
      try {
        const count = Math.min(BATCH_SIZE, TARGET_POOL_SIZE - pool.length);
        if (count <= 0) return;
        const inFlight = Array.from({ length: count }, async () => {
          fillStats.attempts++;
          const proxy = pickProxy();
          if (!proxy) {
            fillStats.failures++;
            throw new Error('No proxy available');
          }
          acquireProxy(proxy);
          try {
            const token = await createAccountWithWorkspace(proxy);
            pool.push({ token, proxy, createdAt: Date.now() });
            fs.appendFileSync(TOKENS_FILE, token + '\n', 'utf-8');
            fillStats.successes++;
            recordProxyResult(proxy, true);
            persistPoolAsync();
          } catch (e) {
            fillStats.failures++;
            const msg = e?.message || String(e);
            if (msg.includes('429')) cooldownProxy(proxy, 2 * 60_000);
            else if (msg.includes('403')) markProxyBlocked(proxy);
            else recordProxyResult(proxy, false);
            throw e;
          } finally {
            releaseProxy(proxy);
          }
        });
        await Promise.allSettled(inFlight);
      } finally {
        fillInProgress--;
        if (fillInProgress === 0) fillPromise = null;
      }
    })();
    promises.push(p);
  }
  fillPromise = Promise.all(promises);
  await fillPromise;
}

function grabToken() {
  if (pool.length < MIN_POOL_SIZE && fillInProgress === 0) {
    fillPool().catch(() => {});
  }
  if (pool.length > 0) {
    const item = pool.pop();
    persistPoolAsync();
    return item.token;
  }
  // Fallback: create on demand
  return null;
}

function warmPool() {
  if (warmed) return;
  warmed = true;
  loadProxies();
  (async () => {
    for (let i = 0; i < 5; i++) {
      await refreshProxies().catch(() => {});
      if (provenProxies.length >= 3) break;
    }
    fillPool().catch(() => {});
  })();

  const t1 = setInterval(() => refreshProxies().catch(() => {}), PROXY_REFRESH_MS);
  const t2 = setInterval(() => {
    if (pool.length < MIN_POOL_SIZE && fillInProgress === 0) {
      fillPool().catch(() => {});
    }
  }, 60_000);
  if (t1.unref) t1.unref();
  if (t2.unref) t2.unref();
}

// ── Main startup ───────────────────────────────────────────────────────────
loadPool();
loadProxyHealth();
warmPool();

// Example usage: Get a token from pool or create one on demand
async function getNotionToken() {
  let token = grabToken();
  if (!token) {
    const proxy = pickProxy();
    if (!proxy) throw new Error('No proxy available');
    acquireProxy(proxy);
    try {
      token = await createAccountWithWorkspace(proxy);
      pool.push({ token, proxy, createdAt: Date.now() });
      persistPoolAsync();
      recordProxyResult(proxy, true);
    } catch (e) {
      recordProxyResult(proxy, false);
      throw e;
    } finally {
      releaseProxy(proxy);
    }
  }
  return token;
}

// Keep running in background (if you want the script to stay alive for pooling)
setInterval(() => {}, 1 << 30); // Prevent exit

module.exports = { getNotionToken, getPoolStats: () => ({ pool: pool.length, stats: fillStats }) };
