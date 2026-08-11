'use strict';

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Apply stealth plugin to help bypass Cloudflare detection
puppeteer.use(StealthPlugin());

const TOKENS_FILE = path.join(__dirname, 'notion-tokens.txt');
const TARGET_ACCOUNTS = 5; // Reduced default to minimize immediate banning

// Helper function to make HTTPS JSON requests
function requestJSON(url, options = {}, bodyData = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...(options.headers || {}) };
    let bodyString = bodyData ? JSON.stringify(bodyData) : null;
    if (bodyString) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyString);
    }

    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: options.method || (bodyData ? 'POST' : 'GET'),
      headers
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });

    req.on('error', reject);
    if (bodyString) req.write(bodyString);
    req.end();
  });
}

// Creates a temporary mailbox. Note: Notion frequently blocks mail.tm.
// If registration fails, you may need to swap this out for a private email domain API.
async function createTempMailbox() {
  const domains = await requestJSON('https://api.mail.tm/domains');
  if (!domains['hydra:member'] || !domains['hydra:member'].length) {
    throw new Error('No domains available from Mail.tm');
  }
  const domain = domains['hydra:member'][0].domain;
  const username = 'notion_user_' + Math.random().toString(36).substring(2, 10);
  const email = `${username}@${domain}`;
  const password = 'SecuredPass_' + Math.random().toString(36).substring(2, 10);

  await requestJSON('https://api.mail.tm/accounts', {}, { address: email, password });
  const tokenRes = await requestJSON('https://api.mail.tm/token', {}, { address: email, password });
  return { email, authToken: tokenRes.token };
}

// Waits for the 6-digit verification code from Notion
async function waitForNotionCode(authToken) {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const msgs = await requestJSON('https://api.mail.tm/messages', {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });

    const list = msgs['hydra:member'] || [];
    if (list.length > 0) {
      const detail = await requestJSON(`https://api.mail.tm/messages/${list[0].id}`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const text = detail.text || (typeof detail.html === 'string' ? detail.html : detail.html?.[0]) || '';
      const match = text.match(/\b\d{6}\b/);
      if (match) return match[0];
    }
  }
  throw new Error('Verification code timed out. Notion might have blocked this email domain.');
}

async function createAccountWithWorkspace() {
  const { email, authToken } = await createTempMailbox();
  console.log(`[1/5] Temp Email Created: ${email}`);

  // PROXY CONFIGURATION (Highly Recommended):
  // Replace 'ip:port' with your rotating residential proxy to bypass IP bans.
  const proxyServer = ''; // Example: 'http://127.0.0.1:8000'
  
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--window-size=1280,800'
  ];

  if (proxyServer) {
    launchArgs.push(`--proxy-server=${proxyServer}`);
  }

  // Running headless: false (visible browser) reduces Cloudflare flagging significantly
  const browser = await puppeteer.launch({
    headless: false, 
    args: launchArgs
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  try {
    await page.goto('https://www.notion.so/signup', { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    await page.type('input[type="email"]', email, { delay: 50 });
    await page.keyboard.press('Enter');
    console.log(`[2/5] Submitted email... waiting for code...`);

    const code = await waitForNotionCode(authToken);
    console.log(`[3/5] Received Code: ${code}`);

    await page.waitForSelector('input[placeholder*="code"]', { timeout: 20000 }).catch(() => {});
    await page.keyboard.type(code, { delay: 50 });
    await page.keyboard.press('Enter');

    console.log(`[4/5] Logging in & verifying Workspace...`);
    await new Promise(r => setTimeout(r, 7000));

    // Execute internal workspace check & creation in browser context
    const verification = await page.evaluate(async () => {
      try {
        const spacesRes = await fetch('/api/v3/getSpaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        });
        const spacesData = await spacesRes.json();
        const userId = Object.keys(spacesData)[0];

        if (!userId) return { success: false, reason: 'No userId resolved' };

        const userSpaces = spacesData[userId]?.space;
        if (userSpaces && Object.keys(userSpaces).length > 0) {
          return { success: true, spaceId: Object.keys(userSpaces)[0] };
        }

        // Call workspace creation endpoint directly from browser session
        const createRes = await fetch('/api/v3/createSpace', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-notion-active-user-header': userId
          },
          body: JSON.stringify({ name: "My Workspace", planType: "personal" })
        });

        if (createRes.status === 429) {
          return { success: false, reason: 'Rate limited (429) by Notion' };
        }

        const createData = await createRes.json();
        const newSpaceId = createData.spaceId || (createData.recordMap?.space ? Object.keys(createData.recordMap.space)[0] : null);

        return { success: !!newSpaceId, spaceId: newSpaceId };
      } catch (err) {
        return { success: false, reason: err.message };
      }
    });

    if (!verification.success) {
      throw new Error(`Workspace creation failed: ${verification.reason}`);
    }

    const cookies = await page.cookies();
    const tokenCookie = cookies.find(c => c.name === 'token_v2');
    if (!tokenCookie) throw new Error('token_v2 cookie was not issued by Notion.');

    const cleanToken = decodeURIComponent(tokenCookie.value);
    console.log(`[5/5] SUCCESS! Token verified with Space ID: ${verification.spaceId}`);

    await browser.close();
    return cleanToken;

  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function startBotFarm() {
  console.log(`\n🤖 Starting Notion Account Automation...\n`);
  let successCount = 0;

  for (let i = 1; i <= TARGET_ACCOUNTS; i++) {
    console.log(`--- Creating Account #${i}/${TARGET_ACCOUNTS} ---`);
    try {
      const cleanToken = await createAccountWithWorkspace();
      fs.appendFileSync(TOKENS_FILE, cleanToken + '\n', 'utf-8');
      successCount++;
      console.log(`✅ Token successfully saved to notion-tokens.txt\n`);
    } catch (e) {
      console.error(`❌ Account skipped: ${e.message}\n`);
    }

    if (i < TARGET_ACCOUNTS) {
      console.log(`⏳ Waiting 15 seconds to stay under the rate-limit radar...`);
      await new Promise(r => setTimeout(r, 15000));
    }
  }

  console.log(`🎉 Process Finished! Saved ${successCount} active tokens.\n`);
}

startBotFarm();
