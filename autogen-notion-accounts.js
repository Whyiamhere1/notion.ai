'use strict';

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const http = require('http');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

let _SPA, _HPA, _HSPA;
async function loadSPA() { if (!_SPA) { const m = await import('socks-proxy-agent'); _SPA = m.SocksProxyAgent; } return _SPA; }
async function loadHPA() { if (!_HPA) { const m = await import('http-proxy-agent'); _HPA = m.HttpProxyAgent; } return _HPA; }
async function loadHSPA() { if (!_HSPA) { const m = await import('https-proxy-agent'); _HSPA = m.HttpsProxyAgent; } return _HSPA; }

puppeteer.use(StealthPlugin());

const TOKENS_FILE = path.join(__dirname, 'notion-tokens.txt');
const POOL_STATE_FILE = path.join(__dirname, 'notion-pool.json');
const PROXIES_FILE = path.join(__dirname, 'proxies.txt');
const PROXY_HEALTH_FILE = path.join(__dirname, 'notion-proxy-health.json');

const TARGET_POOL_SIZE = 10;
const MIN_POOL_SIZE = 3;
const MAX_CONCURRENT_FILLS = 2;

const PROXIFLY_URL = 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt';
const PROXYSCRAPE_URL = 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&timeout=5000&status=alive';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let cachedProxies = [];
let proxiesLoaded = false;
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
}

function getHealth(proxy) {
  let h = proxyHealth.get(proxy);
  if (!h) {
    h = { ok: 0, fail: 0, blocked: false, coolingUntil: 0, inUse: 0 };
    proxyHealth.set(proxy, h);
  }
  return h;
}

function recordProxyResult(proxy, success) {
  if (!proxy) return;
  const h = getHealth(proxy);
  if (success) {
    h.ok++; h.blocked = false; h.coolingUntil = 0;
    if (!provenProxiesSet.has(proxy)) { provenProxies.push(proxy); provenProxiesSet.add(proxy); }
  } else {
    h.fail++;
    if (h.fail >= 2) {
      h.blocked = true;
      const idx = provenProxies.indexOf(proxy);
      if (idx !== -1) { provenProxies.splice(idx, 1); provenProxiesSet.delete(proxy); }
    }
  }
}

function acquireProxy(proxy) { getHealth(proxy).inUse++; }
function releaseProxy(proxy) { const h = getHealth(proxy); if (h.inUse > 0) h.inUse--; }

function pickProxy() {
  loadProxies();
  const now = Date.now();
  if (provenProxies.length) {
    for (const p of provenProxies) {
      const h = proxyHealth.get(p);
      if (!h || (!h.blocked && h.coolingUntil < now && h.inUse < 2)) return p;
    }
  }
  if (!cachedProxies.length) return undefined;
  return cachedProxies[Math.floor(Math.random() * cachedProxies.length)];
}

async function fetchWithProxy(url, options = {}, proxy) {
  let agent;
  if (proxy) {
    if (proxy.startsWith('socks')) {
      const Agent = await loadSPA();
      agent = new Agent(proxy);
    } else {
      const Agent = await loadHSPA();
      agent = new Agent(proxy);
    }
  }

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers,
      agent
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
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
  if (!domains['hydra:member'] || !domains['hydra:member'].length) throw new Error('Mail.tm unavailable');
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
    const msgs = await requestJSON('https://api.mail.tm/messages', { headers: { 'Authorization': `Bearer ${authToken}` } }, null, proxy);
    const list = msgs['hydra:member'] || [];
    if (list.length > 0) {
      const detail = await requestJSON(`https://api.mail.tm/messages/${list[0].id}`, { headers: { 'Authorization': `Bearer ${authToken}` } }, null, proxy);
      const text = detail.text || (typeof detail.html === 'string' ? detail.html : detail.html?.[0]) || '';
      const match = text.match(/\b\d{6}\b/);
      if (match) return match[0];
    }
  }
  throw new Error('Verification code timed out');
}

// ── AUTHENTICATED ACCOUNT CREATOR ──────────────────────────────────────────

async function createAccountWithWorkspace(proxy) {
  const { email, authToken } = await createTempMailbox(proxy);
  console.log(`[1/5] Temp Email Created: ${email}`);

  const browserArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--headless=new'];
  if (proxy) browserArgs.push(`--proxy-server=${proxy}`);

  const browser = await puppeteer.launch({ headless: 'new', args: browserArgs });
  const page = await browser.newPage();

  try {
    await page.goto('https://www.notion.so/signup', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('input[type="email"]', { timeout: 15000 });
    await page.type('input[type="email"]', email, { delay: 30 });
    await page.keyboard.press('Enter');
    console.log(`[2/5] Submitted email... waiting for code...`);

    const code = await waitForNotionCode(authToken, proxy);
    console.log(`[3/5] Received Code: ${code}`);

    const codeInput = await page.waitForSelector('input[placeholder*="code"], input[type="text"]', { timeout: 15000 });
    await codeInput.type(code, { delay: 40 });

    // Click submit/continue button in UI
    const submitBtn = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
      return btns.find(b => {
        const txt = (b.textContent || '').toLowerCase();
        return txt.includes('continue') || txt.includes('login') || txt.includes('submit');
      });
    });

    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    console.log(`[4/5] Submitted code. Verifying authentication token...`);

    // VERIFY AUTHENTICATION: Wait until token_v2 exists in browser cookies
    let authenticated = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const cookies = await page.cookies();
      const tokenCookie = cookies.find(c => c.name === 'token_v2');
      if (tokenCookie && tokenCookie.value) {
        authenticated = true;
        break;
      }
    }

    if (!authenticated) {
      throw new Error('Authentication failed: token_v2 was not issued after code submission.');
    }

    console.log(`[AUTH] token_v2 verified! Resolving workspace IDs...`);

    // Navigate to workspace home page to complete onboarding
    await page.goto('https://www.notion.so/', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    let verification = null;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    for (let attempt = 1; attempt <= 15; attempt++) {
      await new Promise(r => setTimeout(r, 2000));

      verification = await page.evaluate(async () => {
        try {
          const spacesRes = await fetch('/api/v3/getSpaces', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
            credentials: 'include'
          });
          if (!spacesRes.ok) return { success: false, reason: `getSpaces status ${spacesRes.status}` };
          
          const spacesData = await spacesRes.json();
          if (spacesData.isNotionError) return { success: false, reason: 'Waiting for session initialization...' };

          let userId = null;
          let spaceId = null;

          const rootKeys = Object.keys(spacesData);
          for (const k of rootKeys) {
            if (k === 'isNotionError') continue;
            const userData = spacesData[k];
            if (userData && typeof userData === 'object') {
              if (!userId) userId = k;
              if (userData.space) {
                const sKeys = Object.keys(userData.space);
                if (sKeys.length > 0) spaceId = sKeys[0];
              }
            }
          }

          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!userId || !uuidRegex.test(userId)) return { success: false, reason: 'Waiting for valid user UUID...' };

          if (spaceId && uuidRegex.test(spaceId)) return { success: true, spaceId, userId };

          // Create Personal Space via in-page API
          const createRes = await fetch('/api/v3/createSpace', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-notion-active-user-header': userId },
            body: JSON.stringify({ name: "My Workspace", planType: "personal" }),
            credentials: 'include'
          });
          if (!createRes.ok) return { success: false, reason: 'createSpace failed' };

          const createData = await createRes.json();
          const newSpaceId = createData.spaceId || (createData.recordMap?.space ? Object.keys(createData.recordMap.space)[0] : null);
          if (newSpaceId && uuidRegex.test(newSpaceId)) return { success: true, spaceId: newSpaceId, userId };

          return { success: false, reason: 'Space creation in progress...' };
        } catch (err) {
          return { success: false, reason: err.message };
        }
      });

      if (verification && verification.success) break;
    }

    if (!verification || !verification.success) throw new Error('Failed to resolve workspace IDs.');

    const rawCookies = await page.cookies();
    const fullCookieString = rawCookies.map(c => `${c.name}=${c.value}`).join('; ');

    console.log(`[5/5] SUCCESS! Space ID: ${verification.spaceId} | User ID: ${verification.userId}`);
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

// ── POOL MANAGEMENT ────────────────────────────────────────────────────────

let pool = [];
let fillInProgress = 0;

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
      
      if (proxy) recordProxyResult(proxy, true);
      await fsPromises.writeFile(POOL_STATE_FILE, JSON.stringify(pool, null, 2), 'utf-8');
    } catch (e) {
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
    fsPromises.writeFile(POOL_STATE_FILE, JSON.stringify(pool, null, 2), 'utf-8').catch(() => {});
    return item;
  }
  return null;
}

loadPool();

async function getNotionToken() {
  let acc = grabToken();
  if (!acc) {
    console.log(`[AUTOGEN] Creating fresh authenticated account...`);
    const proxy = pickProxy();
    acc = await createAccountWithWorkspace(proxy);
    pool.push({ ...acc, proxy, createdAt: Date.now() });
    fsPromises.writeFile(POOL_STATE_FILE, JSON.stringify(pool, null, 2), 'utf-8').catch(() => {});
  }
  return acc;
}

setInterval(() => {}, 1 << 30);

module.exports = { getNotionToken, getPoolStats: () => ({ pool: pool.length }) };
