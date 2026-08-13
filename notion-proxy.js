'use strict';

const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Dynamic proxy agent loader supporting HTTP, HTTPS, SOCKS4, SOCKS5 [1]
async function getProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    const urlObj = new URL(proxyUrl);
    const protocol = urlObj.protocol.toLowerCase();

    if (protocol.startsWith('socks')) {
      // Handles socks4, socks4a, socks5, socks5h [1]
      const { SocksProxyAgent } = await import('socks-proxy-agent');
      return new SocksProxyAgent(proxyUrl);
    } else if (protocol === 'http:') {
      const { HttpProxyAgent } = await import('http-proxy-agent');
      return new HttpProxyAgent(proxyUrl);
    } else if (protocol === 'https:') {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      return new HttpsProxyAgent(proxyUrl);
    }
  } catch (err) {
    console.error(`[PROXY AGENT ERROR] Invalid proxy URL: ${proxyUrl}`, err.message);
  }
  return undefined;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const TOKENS_FILE = path.join(__dirname, 'notion-tokens.txt');
const PROXIES_FILE = path.join(__dirname, 'proxies.txt');

let NOTION_TOKENS = [];
let PROXY_LIST = [];
const accountCache = new Map();
const proxyHealth = new Map();

// ── PROXY HEALTH MANAGER ───────────────────────────────────────────────────

function getHealth(proxy) {
  let h = proxyHealth.get(proxy);
  if (!h) {
    h = { ok: 0, fail: 0, blocked: false, coolingUntil: 0 };
    proxyHealth.set(proxy, h);
  }
  return h;
}

function recordProxyResult(proxy, statusCode) {
  if (!proxy) return;
  const h = getHealth(proxy);
  if (statusCode >= 200 && statusCode < 300) {
    h.ok++;
    h.blocked = false;
  } else if (statusCode === 429) {
    console.warn(`[PROXY HEALTH] ${proxy} hit Rate Limit (429). Cooldown for 2m.`);
    h.coolingUntil = Date.now() + 120_000;
  } else if (statusCode === 403) {
    console.warn(`[PROXY HEALTH] ${proxy} Blocked (403). Marking dead.`);
    h.blocked = true;
  } else {
    h.fail++;
    if (h.fail >= 3) h.blocked = true;
  }
}

function pickHealthyProxy() {
  const envProxy = process.env.ROTATING_PROXY_URL;
  if (envProxy) return envProxy;

  if (!PROXY_LIST.length) loadProxies();
  if (!PROXY_LIST.length) return undefined;

  const now = Date.now();
  const available = PROXY_LIST.filter(p => {
    const h = getHealth(p);
    return !h.blocked && h.coolingUntil < now;
  });

  if (!available.length) return undefined;
  return available[Math.floor(Math.random() * available.length)];
}

function loadProxies() {
  try {
    if (fs.existsSync(PROXIES_FILE)) {
      const raw = fs.readFileSync(PROXIES_FILE, 'utf-8');
      PROXY_LIST = raw.split(/[\r\n]+/).map(l => l.trim()).filter(l => l && (l.startsWith('socks') || l.startsWith('http')));
      console.log(`[PROXY] Loaded ${PROXY_LIST.length} proxies from proxies.txt.`);
    }
  } catch {}
}

function loadTokens() {
  NOTION_TOKENS = [];

  if (process.env.NOTION_TOKENS) {
    NOTION_TOKENS = process.env.NOTION_TOKENS
      .split(/[\r\n,]+|token_v2=/)
      .map(t => t.trim().replace('token_v2=', ''))
      .filter(Boolean);
  }

  if (!NOTION_TOKENS.length && fs.existsSync(TOKENS_FILE)) {
    try {
      const raw = fs.readFileSync(TOKENS_FILE, 'utf-8');
      NOTION_TOKENS = raw
        .split(/[\r\n]+/)
        .map(l => l.trim().replace('token_v2=', ''))
        .filter(Boolean)
        .map(token => {
          try { return decodeURIComponent(token).trim(); } catch { return token.trim(); }
        });
    } catch {}
  }

  if (NOTION_TOKENS.length > 0) {
    console.log(`[TOKENS] Successfully loaded ${NOTION_TOKENS.length} Notion tokens.`);
  } else {
    console.warn(`[WARNING] No Notion tokens available.`);
  }
}

const MODEL_MAP = {
  "claude-opus-5": "agave-flan",
  "opus": "agave-flan",
  "claude-sonnet-5": "olive-jellyroll",
  "sonnet": "olive-jellyroll",
  "gpt-4o": "oval-kumquat-medium",
  "gpt-4o-mini": "oregon-grape-medium",
  "default": "agave-flan"
};

let currentTokenIndex = 0;

function getNextNotionToken() {
  if (!NOTION_TOKENS.length) {
    loadTokens();
    if (!NOTION_TOKENS.length) throw new Error("No Notion tokens available in pool.");
  }
  const token = NOTION_TOKENS[currentTokenIndex];
  currentTokenIndex = (currentTokenIndex + 1) % NOTION_TOKENS.length;
  return token;
}

// ── ACCOUNT RESOLVER ────────────────────────────────────────────────────────

async function getNotionAccountInfo(rawToken, proxyUrl) {
  const cookie = `token_v2=${rawToken}`;
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
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.notion.so',
        'Referer': 'https://www.notion.so/'
      }
    }, res => {
      recordProxyResult(proxyUrl, res.statusCode);
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          let userId = null;
          let spaceId = null;

          const rootKeys = Object.keys(json);
          if (rootKeys.length > 0) {
            const firstUserKey = rootKeys[0];
            const userData = json[firstUserKey];

            if (userData) {
              userId = userData.notion_user ? Object.keys(userData.notion_user)[0] : firstUserKey;
              if (userData.space) {
                const sKeys = Object.keys(userData.space);
                if (sKeys.length > 0) spaceId = sKeys[0];
              }
            }
          }

          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (userId && uuidRegex.test(userId) && spaceId && uuidRegex.test(spaceId)) {
            console.log(`[RESOLVED] User: ${userId} | Space: ${spaceId} (via ${proxyUrl || 'Direct'})`);
            return resolve({ spaceId, userId });
          }

          reject(new Error(`Could not resolve valid User and Workspace IDs.`));
        } catch (e) {
          reject(new Error(`Failed to parse getSpaces: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => {
      recordProxyResult(proxyUrl, 500);
      reject(err);
    });
    req.write(postData);
    req.end();
  });
}

// ── HTTP PROXY TRANSPORT ────────────────────────────────────────────────────

async function fetchNotionAI(payload, rawToken, userId, spaceId, proxyUrl) {
  const cookie = `token_v2=${rawToken}; notion_user_id=${userId}`;
  const agent = await getProxyAgent(proxyUrl);
  const postData = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.notion.so',
      port: 443,
      path: '/api/v3/runInferenceTranscript',
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.notion.so',
        'Referer': 'https://www.notion.so/',
        'x-notion-active-user-header': userId,
        'x-notion-space-id': spaceId
      }
    }, res => {
      recordProxyResult(proxyUrl, res.statusCode);
      resolve(res);
    });

    req.on('error', (err) => {
      recordProxyResult(proxyUrl, 500);
      reject(err);
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Connection timeout')); });
    req.write(postData);
    req.end();
  });
}

function packMessages(messages) {
  let promptText = "";
  for (const m of messages) {
    const role = (m.role || "").toUpperCase();
    const content = m.content || "";
    if (!content) continue;
    if (role === "SYSTEM") promptText += `[SYSTEM INSTRUCTIONS]\n${content}\n\n`;
    else if (role === "ASSISTANT") promptText += `Assistant: ${content}\n`;
    else promptText += `User: ${content}\n`;
  }
  return promptText.trim();
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

  if (!req.body.messages || !Array.isArray(req.body.messages) || req.body.messages.length === 0) {
    return res.status(400).json({ error: { message: '"messages" must be a non-empty array', type: "invalid_request", code: 400 } });
  }

  const requestedModel = req.body.model || "claude-sonnet-5";
  const notionModel = MODEL_MAP[requestedModel.toLowerCase()] || MODEL_MAP["default"];

  const promptText = packMessages(req.body.messages);
  const tokenCookie = getNextNotionToken();
  const proxyUrl = pickHealthyProxy();

  try {
    let accountInfo = accountCache.get(tokenCookie);
    if (!accountInfo) {
      accountInfo = await getNotionAccountInfo(tokenCookie, proxyUrl);
      accountCache.set(tokenCookie, accountInfo);
    }

    const threadId = crypto.randomUUID();
    const notionPayload = {
      spaceId: accountInfo.spaceId,
      threadId: threadId,
      createThread: true,
      isPartialTranscript: true,
      asPatchResponse: true,
      transcript: [
        {
          id: crypto.randomUUID(),
          type: "config",
          value: { type: "thread", model: notionModel, useWebSearch: true }
        },
        {
          id: crypto.randomUUID(),
          type: "context",
          value: { userName: "User", surface: "workflows" }
        },
        {
          id: crypto.randomUUID(),
          type: "user",
          value: [[ promptText ]],
          userId: accountInfo.userId,
          createdAt: new Date().toISOString()
        }
      ]
    };

    console.log(`[REQUEST] Model: ${notionModel} | Proxy: ${proxyUrl || 'Direct'}`);

    const notionRes = await fetchNotionAI(
      notionPayload, 
      tokenCookie, 
      accountInfo.userId, 
      accountInfo.spaceId, 
      proxyUrl
    );

    if (notionRes.statusCode >= 400) {
      let body = '';
      notionRes.on('data', d => body += d);
      notionRes.on('end', () => {
        console.error(`[NOTION ERROR ${notionRes.statusCode}]`, body);
        if (!res.headersSent) res.status(notionRes.statusCode).json({ error: `Notion Error ${notionRes.statusCode}`, details: body });
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);

    let streamEnded = false;
    const keepAlive = setInterval(() => { if (!streamEnded) res.write(': keepalive\n\n'); }, 15000);

    notionRes.on('data', chunk => {
      const raw = chunk.toString();
      const lines = raw.split('\n').filter(Boolean);

      for (const line of lines) {
        let textChunk = '';
        try {
          const parsed = JSON.parse(line);
          textChunk = parsed.text || parsed.delta || (parsed.type === 'text' ? parsed.text : '');
        } catch {
          textChunk = line;
        }

        if (textChunk) {
          textChunk = textChunk.replace(/<thinking>[\s\S]*?<\/thinking>\s*/gi, '');
          res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { content: textChunk } }] })}\n\n`);
        }
      }
    });

    notionRes.on('end', () => {
      clearInterval(keepAlive);
      streamEnded = true;
      res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

  } catch (err) {
    console.error('[PROXY ERROR]', err.message);
    if (!res.headersSent) res.status(500).json({ error: { message: err.message, type: 'notion_proxy_error' } });
  }
});

loadProxies();
loadTokens();

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Notion AI Proxy Server running on http://localhost:${PORT}/v1`);
});
