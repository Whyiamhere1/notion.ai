'use strict';

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const http = require('http');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

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

const TOKENS_FILE = path.join(__dirname, 'notion-tokens.txt');
const POOL_STATE_FILE = path.join(__dirname, 'notion-pool.json');
const PROXIES_FILE = path.join(__dirname, 'proxies.txt');
const PROXY_HEALTH_FILE = path.join(__dirname, 'notion-proxy-health.json');

const TARGET_POOL_SIZE = 20;
const MIN_POOL_SIZE = 8;
const MAX_CONCURRENT_FILLS = 3;

const PROXIFLY_URL = 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt';
const PROXYSCRAPE_URL = 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&timeout=5000&status=alive';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
      if (h.blocked || h.coolingUntil > now || h.inUse >= 2) continue;
      return p;
    }
  }

  if (!cachedProxies.length) return undefined;
  return cachedProxies[Math.floor(Math.random() * cachedProxies.length)];
}

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

// ── Mail.tm API ─────────────────────────────────────────────────────────────
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

// ── Notion Account Creation (Fixed Auth Flow) ──────────────────────────────
async function createAccountWithWorkspace(proxy) {
  const { email, authToken } = await createTempMailbox(proxy);
  console.log(`[1/5] Temp Email Created: ${email} (via ${proxy || 'Direct'})`);

  const browserArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--headless=new',
    '--window-size=1280,800'
  ];
  if (proxy) browserArgs.push(`--proxy-server=${proxy}`);

  const browser = await puppeteer.launch({ headless: 'new', args: browserArgs });
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

    console.log(`[4/5] Code submitted. Waiting for authentication navigation...`);

    // FIX: Wait for navigation so Notion sets token_v2
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    let verification = null;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    for (let attempt = 1; attempt <= 15; attempt++) {
      await new Promise(r => setTimeout(r, 2000));

      verification = await page.evaluate(async () => {
        try {
          const spacesRes = await fetch('/api/v3/getSpaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          if (!spacesRes.ok) return { success: false, reason: `getSpaces status ${spacesRes.status}` };
          
          const spacesData = await spacesRes.json();
          const userId = spacesData.notion_user ? Object.keys(spacesData.notion_user)[0] : null;
          let spaceId = spacesData.space ? Object.keys(spacesData.space)[0] : null;

          if (!userId || !uuidRegex.test(userId)) return { success: false, reason: 'Waiting for valid user session...' };
          if (spaceId && uuidRegex.test(spaceId)) return { success: true, spaceId, userId };

          const createRes = await fetch('/api/v3/createSpace', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-notion-active-user-header': userId },
            body: JSON.stringify({ name: "My Workspace", planType: "personal" })
          });
          if (!createRes.ok) return { success: false, reason: `createSpace status ${createRes.status}` };

          const createData = await createRes.json();
          const newSpaceId = createData.spaceId || (createData.recordMap?.space ? Object.keys(createData.recordMap.space)[0] : null);
          if (newSpaceId && uuidRegex.test(newSpaceId)) return { success: true, spaceId: newSpaceId, userId };
          
          return { success: false, reason: 'Failed to extract spaceId' };
        } catch (err) {
          return { success: false, reason: err.message };
        }
      });

      if (verification && verification.success) break;
    }

    if (!verification || !verification.success) throw new Error('Workspace creation failed');

    // FIX: Verify token_v2 exists in cookies
    const rawCookies = await page.cookies();
    const hasTokenV2 = rawCookies.some(c => c.name === 'token_v2');
    if (!hasTokenV2) {
      throw new Error('Authentication failed: token_v2 cookie was not issued');
    }

    const fullCookieString = rawCookies.map(c => `${c.name}=${c.value}`).join('; ');

    console.log(`[5/5] SUCCESS! Session authenticated with Space ID: ${verification.spaceId}`);
    await browser.close();

    return {
      cookieString: fullCookieString,
      userId: verification.userId,
      spaceId: verification.spaceId
    };

  } catch (err) {
    try { await browser.close(); } catch {}
    throw err;
  }
}

// ── Account Pool Management ────────────────────────────────────────────────
let pool = [];
let fillInProgress = 0;
let warmed = false;
let fillStats = { attempts: 0, successes: 0, failures: 0 };

function persistPoolAsync() {
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

  fillInProgress++;
  try {
    const proxy = pickProxy();
    if (proxy) acquireProxy(proxy);
    try {
      const acc = await createAccountWithWorkspace(proxy);
      pool.push({ ...acc, proxy, createdAt: Date.now() });
      
      const recordLine = JSON.stringify({
        cookieString: acc.cookieString,
        userId: acc.userId,
        spaceId: acc.spaceId
      });
      fs.appendFileSync(TOKENS_FILE, recordLine + '\n', 'utf-8');
      
      fillStats.successes++;
      if (proxy) recordProxyResult(proxy, true);
      persistPoolAsync();
    } catch (e) {
      fillStats.failures++;
      if (proxy) recordProxyResult(proxy, false);
    } finally {
      if (proxy) releaseProxy(proxy);
    }
  } finally {
    fillInProgress--;
  }
}

function grabToken() {
  if (pool.length < MIN_POOL_SIZE && fillInProgress === 0) fillPool().catch(() => {});
  if (pool.length > 0) {
    const item = pool.pop();
    persistPoolAsync();
    return item;
  }
  return null;
}

function warmPool() {
  if (warmed) return;
  warmed = true;
  loadProxies();
  fillPool().catch(() => {});
  setInterval(() => {
    if (pool.length < MIN_POOL_SIZE && fillInProgress === 0) fillPool().catch(() => {});
  }, 60_000);
}

loadPool();
loadProxyHealth();
warmPool();

async function getNotionToken() {
  let acc = grabToken();
  if (!acc) {
    const proxy = pickProxy();
    acc = await createAccountWithWorkspace(proxy);
    pool.push({ ...acc, proxy, createdAt: Date.now() });
    persistPoolAsync();
  }
  return acc;
}

setInterval(() => {}, 1 << 30);

module.exports = { getNotionToken, getPoolStats: () => ({ pool: pool.length, stats: fillStats }) };
