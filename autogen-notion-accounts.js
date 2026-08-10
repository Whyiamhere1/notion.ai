'use strict';

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const TOKENS_FILE = path.join(__dirname, 'notion-tokens.txt');
const TARGET_ACCOUNTS = 10;

function requestJSON(url, options = {}, bodyData = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { 'User-Agent': 'Mozilla/5.0', ...(options.headers || {}) };
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

async function createTempMailbox() {
  const domains = await requestJSON('https://api.mail.tm/domains');
  if (!domains['hydra:member'] || !domains['hydra:member'].length) {
    throw new Error('No domains available from Mail.tm');
  }
  const domain = domains['hydra:member'][0].domain;
  const username = 'bot_' + Math.random().toString(36).substring(2, 10);
  const email = `${username}@${domain}`;
  const password = 'Password_' + Math.random().toString(36).substring(2, 10);

  await requestJSON('https://api.mail.tm/accounts', {}, { address: email, password });
  const tokenRes = await requestJSON('https://api.mail.tm/token', {}, { address: email, password });
  return { email, authToken: tokenRes.token };
}

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
  throw new Error('Verification code timed out');
}

async function createAccountWithWorkspace() {
  const { email, authToken } = await createTempMailbox();
  console.log(`[1/5] Temp Email Created: ${email}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--headless=new', '--window-size=1280,800']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  try {
    await page.goto('https://www.notion.so/signup', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('input[type="email"]', { timeout: 15000 });
    await page.type('input[type="email"]', email, { delay: 30 });
    await page.keyboard.press('Enter');
    console.log(`[2/5] Submitted email... waiting for code...`);

    const code = await waitForNotionCode(authToken);
    console.log(`[3/5] Received Code: ${code}`);

    await page.waitForSelector('input[placeholder*="code"]', { timeout: 15000 }).catch(() => {});
    await page.keyboard.type(code, { delay: 30 });
    await page.keyboard.press('Enter');

    console.log(`[4/5] Logging in & verifying Workspace...`);
    await new Promise(r => setTimeout(r, 5000));

    // Verify or force workspace creation in browser session
    const verification = await page.evaluate(async () => {
      try {
        const spacesRes = await fetch('/api/v3/getSpaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        });
        const spacesData = await spacesRes.json();
        const userId = Object.keys(spacesData)[0];

        if (!userId) return { success: false, reason: 'No userId found' };

        const userSpaces = spacesData[userId]?.space;
        if (userSpaces && Object.keys(userSpaces).length > 0) {
          return { success: true, spaceId: Object.keys(userSpaces)[0] };
        }

        // Call createSpace endpoint inside browser
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
    if (!tokenCookie) throw new Error('token_v2 cookie not found');

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
  console.log(`\n🤖 Starting Notion Bot Farm (With 10s Delay Between Accounts)...\n`);
  let successCount = 0;

  for (let i = 1; i <= TARGET_ACCOUNTS; i++) {
    console.log(`--- Creating Account #${i}/${TARGET_ACCOUNTS} ---`);
    try {
      const cleanToken = await createAccountWithWorkspace();
      fs.appendFileSync(TOKENS_FILE, cleanToken + '\n', 'utf-8');
      successCount++;
      console.log(`✅ Clean token saved to notion-tokens.txt\n`);
    } catch (e) {
      console.error(`❌ Account skipped: ${e.message}\n`);
    }

    // 10 second delay between accounts to avoid triggering Notion's 429 rate limit
    if (i < TARGET_ACCOUNTS) {
      console.log(`⏳ Waiting 10 seconds before next account to prevent rate-limits...`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  console.log(`🎉 Finished! Saved ${successCount} valid accounts with workspaces.\n`);
}

startBotFarm();
