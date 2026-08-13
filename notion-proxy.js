'use strict';

const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let autogen = null;
try {
  autogen = require('./autogen-notion-accounts.js');
  console.log('[SYSTEM] Loaded autogen account generator module.');
} catch (e1) {
  try {
    autogen = require('./autogen.js');
  } catch (e2) {
    console.warn('[WARNING] autogen module not found. Running in standalone proxy mode.');
  }
}

async function getProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    const urlObj = new URL(proxyUrl);
    const protocol = urlObj.protocol.toLowerCase();

    if (protocol.startsWith('socks')) {
      const { SocksProxyAgent } = await import('socks-proxy-agent');
      return new SocksProxyAgent(proxyUrl);
    } else if (protocol === 'http:') {
      const { HttpProxyAgent } = await import('http-proxy-agent');
      return new HttpProxyAgent(proxyUrl);
    } else if (protocol === 'https:') {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      return new HttpsProxyAgent(proxyUrl);
    }
  } catch (err) {}
  return undefined;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const TOKENS_FILE = path.join(__dirname, 'notion-tokens.txt');
let NOTION_TOKENS = [];
const accountCache = new Map();

function parseAccountLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.cookieString && parsed.userId !== 'isNotionError') {
      return parsed;
    }
  } catch {}
  return { cookieString: trimmed };
}

function loadTokens() {
  NOTION_TOKENS = [];

  if (process.env.NOTION_TOKENS) {
    const rawEnv = process.env.NOTION_TOKENS.split(/[\r\n]+/);
    for (const line of rawEnv) {
      const acc = parseAccountLine(line);
      if (acc) NOTION_TOKENS.push(acc);
    }
  }

  if (!NOTION_TOKENS.length && fs.existsSync(TOKENS_FILE)) {
    try {
      const raw = fs.readFileSync(TOKENS_FILE, 'utf-8');
      const lines = raw.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const acc = parseAccountLine(line);
        if (acc) NOTION_TOKENS.push(acc);
      }
    } catch {}
  }

  console.log(`[TOKENS] Loaded ${NOTION_TOKENS.length} account cookie sets.`);
}

async function getNextAccount() {
  if (!NOTION_TOKENS.length) {
    loadTokens();
  }
  
  if (!NOTION_TOKENS.length) {
    if (autogen && typeof autogen.getNotionToken === 'function') {
      console.log(`[PROXY] Token pool empty! Triggering autogen for a fresh live token...`);
      try {
        const newAcc = await autogen.getNotionToken();
        if (newAcc && (newAcc.cookieString || typeof newAcc === 'string')) {
          const formatted = typeof newAcc === 'string' ? { cookieString: newAcc } : newAcc;
          NOTION_TOKENS.push(formatted);
          return formatted;
        }
      } catch (err) {
        console.error(`[AUTOGEN ERROR] Live account creation failed:`, err.message);
      }
    }
    throw new Error("No Notion tokens available in pool. Please set NOTION_TOKENS environment variable.");
  }

  const acc = NOTION_TOKENS.shift();
  NOTION_TOKENS.push(acc);
  return acc;
}

function purgeAccount(cookieString) {
  NOTION_TOKENS = NOTION_TOKENS.filter(a => a.cookieString !== cookieString);
  accountCache.delete(cookieString);
  console.log(`[PROXY] Purged dead token. Remaining active tokens: ${NOTION_TOKENS.length}`);
}

const MODEL_MAP = {
  "claude-opus-5": "agave-flan",
  "claude-sonnet-5": "olive-jellyroll",
  "gpt-4o": "oval-kumquat-medium",
  "default": "olive-jellyroll"
};

// ── FAST-PATH ACCOUNT RESOLVER ─────────────────────────────────────────────

async function getNotionAccountInfo(accountObj, proxyUrl) {
  // FAST-PATH: If userId and spaceId are pre-resolved, bypass getSpaces completely
  if (accountObj.userId && accountObj.spaceId && accountObj.userId !== 'isNotionError') {
    return { userId: accountObj.userId, spaceId: accountObj.spaceId };
  }

  const cookieString = accountObj.cookieString || accountObj;
  
  let userId = null;
  const userMatch = cookieString.match(/notion_user_id=([0-9a-f-]{36})/i);
  if (userMatch) userId = userMatch[1];

  const agent = await getProxyAgent(proxyUrl);

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({});
    const req = https.request({
      hostname: 'www.notion.so',
      port: 443,
      path: '/api/v3/getSpaces',
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.notion.so',
        'Referer': 'https://www.notion.so/',
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'x-notion-active-user-header': userId || ''
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            console.error(`[GETSPACES ERROR ${res.statusCode}]`, body);
            return reject(new Error(`Notion HTTP ${res.statusCode}`));
          }

          const json = JSON.parse(body);
          let spaceId = null;

          const rootKeys = Object.keys(json);
          for (const k of rootKeys) {
            if (k === 'isNotionError') continue;
            const userData = json[k];
            if (userData && typeof userData === 'object') {
              if (!userId) userId = k;
              if (userData.space) {
                const sKeys = Object.keys(userData.space);
                if (sKeys.length > 0) { spaceId = sKeys[0]; break; }
              }
            }
          }

          if (!spaceId) {
            const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
            const matches = body.match(uuidRegex) || [];
            const unique = [...new Set(matches)];
            for (const u of unique) {
              if (u !== userId) { spaceId = u; break; }
            }
          }

          const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (userId && spaceId && uuidPattern.test(spaceId)) {
            console.log(`[RESOLVED] User: ${userId} | Space: ${spaceId}`);
            return resolve({ userId, spaceId });
          }

          reject(new Error("Could not resolve workspace IDs."));
        } catch (e) {
          reject(new Error(`Failed to parse getSpaces: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── HTTP PROXY TRANSPORT WITH BROWSER HEADERS ───────────────────────────────

async function fetchNotionAI(payload, cookieString, userId, spaceId, proxyUrl) {
  const agent = await getProxyAgent(proxyUrl);
  const postData = JSON.stringify(payload);

  const tokenMatch = cookieString.match(/token_v2=([^;]+)/i);
  let rawToken = tokenMatch ? tokenMatch[1] : '';
  try { rawToken = decodeURIComponent(rawToken); } catch {}

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
    'Cookie': cookieString,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': 'https://www.notion.so',
    'Referer': 'https://www.notion.so/',
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'x-notion-active-user-header': userId,
    'x-notion-space-id': spaceId,
    'x-notion-client-version': '23.13.20260313.1423'
  };

  if (rawToken) {
    headers['Authorization'] = `Bearer ${rawToken}`;
  }

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.notion.so',
      port: 443,
      path: '/api/v3/runInferenceTranscript',
      method: 'POST',
      agent,
      headers
    }, res => {
      resolve(res);
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Connection timeout')); });
    req.write(postData);
    req.end();
  });
}

// ── OPENAI COMPATIBLE ROUTES ─────────────────────────────────────────────────

app.get('/v1/models', (req, res) => {
  res.json({
    object: "list",
    data: Object.keys(MODEL_MAP).map(m => ({ id: m, object: "model", created: 1700000000, owned_by: "notion-ai" }))
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  const completionId = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const requestedModel = req.body.model || "claude-sonnet-5";
  const notionModel = MODEL_MAP[requestedModel.toLowerCase()] || MODEL_MAP["default"];

  const promptText = (req.body.messages || []).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
  
  let accountObj;
  try {
    accountObj = await getNextAccount();
  } catch (e) {
    return res.status(500).json({ error: { message: e.message, type: "no_tokens_available" } });
  }

  try {
    let accountInfo = accountCache.get(accountObj.cookieString);
    if (!accountInfo) {
      accountInfo = await getNotionAccountInfo(accountObj);
      accountCache.set(accountObj.cookieString, accountInfo);
    }

    const notionPayload = {
      taskType: "workflow",
      traceId: crypto.randomUUID(),
      spaceId: accountInfo.spaceId,
      threadId: crypto.randomUUID(),
      createThread: true,
      isPartialTranscript: true,
      asPatchResponse: true,
      transcript: [
        { id: crypto.randomUUID(), type: "config", value: { type: "thread", model: notionModel, useWebSearch: true } },
        { id: crypto.randomUUID(), type: "context", value: { userName: "User", surface: "workflows" } },
        { id: crypto.randomUUID(), type: "user", value: [[ promptText ]], userId: accountInfo.userId, createdAt: new Date().toISOString() }
      ]
    };

    console.log(`[REQUEST] Model: ${notionModel} | User: ${accountInfo.userId}`);

    const notionRes = await fetchNotionAI(notionPayload, accountObj.cookieString, accountInfo.userId, accountInfo.spaceId);

    if (notionRes.statusCode === 401) {
      console.error(`[401 UNAUTHORIZED] Expired session. Purging token.`);
      purgeAccount(accountObj.cookieString);
      if (!res.headersSent) {
        return res.status(401).json({ error: { message: "Account unauthorized. Token purged.", type: "notion_unauthorized" } });
      }
      return;
    }

    if (notionRes.statusCode >= 400) {
      let body = '';
      notionRes.on('data', d => body += d);
      notionRes.on('end', () => {
        if (!res.headersSent) {
          res.status(notionRes.statusCode).json({ error: `Notion Error ${notionRes.statusCode}`, details: body });
        }
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);

    notionRes.on('data', chunk => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const textChunk = parsed.text || parsed.delta || (parsed.type === 'text' ? parsed.text : '');
          if (textChunk) {
            res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { content: textChunk } }] })}\n\n`);
          }
        } catch {}
      }
    });

    notionRes.on('end', () => {
      res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: { message: err.message, type: 'notion_proxy_error' } });
  }
});

loadTokens();

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Notion AI Proxy Server running on http://localhost:${PORT}/v1`);
});
