'use strict';

const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _HSPA, _SPA;
async function loadHSPA() { if (!_HSPA) { const m = await import('https-proxy-agent'); _HSPA = m.HttpsProxyAgent; } return _HSPA; }
async function loadSPA() { if (!_SPA) { const m = await import('socks-proxy-agent'); _SPA = m.SocksProxyAgent; } return _SPA; }

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const TOKENS_FILE = path.join(__dirname, 'notion-tokens.txt');
let NOTION_TOKENS = [];
const accountCache = new Map();

function loadTokens() {
  try {
    const raw = fs.readFileSync(TOKENS_FILE, 'utf-8');
    NOTION_TOKENS = raw
      .split(/[\r\n]+|token_v2=/)
      .map(l => l.trim())
      .filter(Boolean)
      .map(token => {
        let cleaned = token;
        if (cleaned.startsWith('token_v2=')) {
          cleaned = cleaned.replace('token_v2=', '');
        }
        try { cleaned = decodeURIComponent(cleaned); } catch {}
        return cleaned.trim();
      });

    console.log(`[PROXY] Successfully loaded ${NOTION_TOKENS.length} Notion tokens.`);
  } catch {
    console.warn(`[WARNING] notion-tokens.txt not found on startup.`);
    NOTION_TOKENS = [];
  }
}

// Updated 2026 Notion AI Model Mapping
const MODEL_MAP = {
  "claude-sonnet-5": "anthropic-sonnet-alt",
  "claude-sonnet": "anthropic-sonnet-alt",
  "claude-sonnet-4.5": "anthropic-sonnet-alt",
  "claude-opus-5": "anthropic-opus-4.1",
  "claude-opus": "anthropic-opus-4.1",
  "gpt-4o": "openai-turbo",
  "gpt-5": "openai-turbo",
  "gpt-4.1": "openai-gpt-4.1",
  "default": "anthropic-sonnet-alt"
};

let currentTokenIndex = 0;

function getNextNotionToken() {
  if (!NOTION_TOKENS.length) {
    loadTokens();
    if (!NOTION_TOKENS.length) throw new Error("No Notion tokens available in notion-tokens.txt.");
  }
  const token = NOTION_TOKENS[currentTokenIndex];
  currentTokenIndex = (currentTokenIndex + 1) % NOTION_TOKENS.length;
  return token;
}

// ── WORKSPACE CREATOR ENDPOINT ──────────────────────────────────────────────

async function createSpace(rawToken, userId, proxyUrl) {
  const cookie = `token_v2=${rawToken}`;
  let agent;
  if (proxyUrl) {
    if (proxyUrl.startsWith('socks')) {
      const Agent = await loadSPA();
      agent = new Agent(proxyUrl);
    } else {
      const Agent = await loadHSPA();
      agent = new Agent(proxyUrl);
    }
  }

  const postData = JSON.stringify({ name: "My Workspace", planType: "personal" });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.notion.so',
      port: 443,
      path: '/api/v3/createSpace',
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.notion.so',
        'Referer': 'https://www.notion.so/',
        'x-notion-active-user-header': userId
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 429) {
          console.error(`[PROXY] createSpace hit Rate Limit (429) on IP.`);
          return resolve(null);
        }
        try {
          const resJson = JSON.parse(body);
          if (resJson.spaceId) return resolve(resJson.spaceId);
          if (resJson.recordMap && resJson.recordMap.space) {
            const keys = Object.keys(resJson.recordMap.space);
            if (keys.length > 0) return resolve(keys[0]);
          }
        } catch (e) {}
        resolve(null);
      });
    });

    req.on('error', () => resolve(null));
    req.write(postData);
    req.end();
  });
}

// ── ACCOUNT RESOLVER ────────────────────────────────────────────────────────

async function getNotionAccountInfo(rawToken, proxyUrl) {
  const cookie = `token_v2=${rawToken}`;
  let agent;
  if (proxyUrl) {
    if (proxyUrl.startsWith('socks')) {
      const Agent = await loadSPA();
      agent = new Agent(proxyUrl);
    } else {
      const Agent = await loadHSPA();
      agent = new Agent(proxyUrl);
    }
  }

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
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', async () => {
        try {
          const json = JSON.parse(body);
          let userId = null;
          let spaceId = null;

          const rootKeys = Object.keys(json);
          if (rootKeys.length > 0) {
            userId = rootKeys[0];
            const userEntry = json[userId];

            if (userEntry && userEntry.space) {
              const sKeys = Object.keys(userEntry.space);
              if (sKeys.length > 0) spaceId = sKeys[0];
            }
          }

          if (userId && !spaceId) {
            console.log(`[PROXY] Account ${userId} has no space. Attempting auto-creation...`);
            spaceId = await createSpace(rawToken, userId, proxyUrl);
          }

          if (userId && spaceId) {
            console.log(`[PROXY] Account Resolved -> User: ${userId} | Space: ${spaceId}`);
            return resolve({ spaceId, userId });
          }

          reject(new Error(`Notion account missing workspace.`));
        } catch (e) {
          reject(new Error(`Failed to parse getSpaces response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── HTTP PROXY TRANSPORT ────────────────────────────────────────────────────

async function fetchNotionAI(payload, rawToken, userId, proxyUrl) {
  const cookie = `token_v2=${rawToken}`;
  let agent;
  if (proxyUrl) {
    if (proxyUrl.startsWith('socks')) {
      const Agent = await loadSPA();
      agent = new Agent(proxyUrl);
    } else {
      const Agent = await loadHSPA();
      agent = new Agent(proxyUrl);
    }
  }

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
        'x-notion-active-user-header': userId
      }
    }, res => {
      resolve(res);
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Notion connection timeout')); });
    req.write(postData);
    req.end();
  });
}

function packMessagesForNotion(messages) {
  let promptText = "";
  for (const m of messages) {
    const role = (m.role || "").toUpperCase();
    const content = m.content || "";
    if (!content) continue;
    if (role === "SYSTEM") {
      promptText += `[SYSTEM INSTRUCTIONS]\n${content}\n\n`;
    } else if (role === "ASSISTANT") {
      promptText += `Assistant: ${content}\n`;
    } else {
      promptText += `User: ${content}\n`;
    }
  }
  return promptText.trim();
}

// ── OPENAI ROUTES ────────────────────────────────────────────────────────────

app.get('/v1/models', (req, res) => {
  res.json({
    object: "list",
    data: Object.keys(MODEL_MAP).map(m => ({ id: m, object: "model", created: 1700000000, owned_by: "notion-ai" }))
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  const completionId = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const requestedModel = req.body.model || "claude-sonnet";
  const notionModel = MODEL_MAP[requestedModel.toLowerCase()] || "anthropic-sonnet-alt";

  const promptText = packMessagesForNotion(req.body.messages || []);
  const tokenCookie = getNextNotionToken();
  const proxyUrl = process.env.ROTATING_PROXY_URL || undefined;

  try {
    let accountInfo = accountCache.get(tokenCookie);
    if (!accountInfo) {
      accountInfo = await getNotionAccountInfo(tokenCookie, proxyUrl);
      accountCache.set(tokenCookie, accountInfo);
    }

    const threadId = crypto.randomUUID();
    const threadType = "chat";

    // Modern 2026 Notion Payload Schema (to avoid 400 ValidationErrors)
    const notionPayload = {
      traceId: crypto.randomUUID(),
      spaceId: accountInfo.spaceId,
      transcript: [
        {
          id: crypto.randomUUID(),
          type: "config",
          value: {
            type: threadType,
            model: notionModel,
            useWebSearch: true
          }
        },
        {
          id: crypto.randomUUID(),
          type: "context",
          value: {
            userName: "User",
            surface: "workflows"
          }
        },
        {
          id: crypto.randomUUID(),
          type: "user",
          value: [[ promptText ]],
          userId: accountInfo.userId,
          createdAt: new Date().toISOString()
        }
      ],
      threadId: threadId,
      createThread: false,
      isPartialTranscript: true,
      asPatchResponse: true,
      generateTitle: true,
      saveAllThreadOperations: true,
      threadType: threadType
    };

    console.log(`[REQUEST] Model: ${notionModel} | Space: ${accountInfo.spaceId} | User: ${accountInfo.userId}`);

    const notionRes = await fetchNotionAI(notionPayload, tokenCookie, accountInfo.userId, proxyUrl);

    if (notionRes.statusCode >= 400) {
      let body = '';
      notionRes.on('data', d => body += d);
      notionRes.on('end', () => {
        console.error(`[NOTION ERROR ${notionRes.statusCode}]`, body);
        res.status(notionRes.statusCode).json({ error: `Notion Error ${notionRes.statusCode}`, details: body });
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);

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
          res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { content: textChunk } }] })}\n\n`);
        }
      }
    });

    notionRes.on('end', () => {
      res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

  } catch (err) {
    console.error('[PROXY ERROR]', err.message);
    accountCache.delete(tokenCookie);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message, type: 'notion_proxy_error' } });
    }
  }
});

loadTokens();

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================================`);
  console.log(`🚀 Notion AI Proxy Server running on http://localhost:${PORT}/v1`);
  console.log(`======================================================================\n`);
});
