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
    console.log(`[PROXY] Loaded ${NOTION_TOKENS.length} tokens.`);
  } catch {
    console.warn('[WARNING] notion-tokens.txt not found.');
    NOTION_TOKENS = [];
  }
}

// ── MODEL MAP – use the exact name from AI analysis ────────────────────
const MODEL_MAP = {
  "claude-fable-5": "anthropic-sonnet-3.5-stable",
  "fable-5": "anthropic-sonnet-3.5-stable",
  "claude-sonnet-5": "anthropic-sonnet-3.5-stable",
  "claude-opus-5": "anthropic-opus-4.8",
  "gpt-4o": "openai-gpt-4o",
  "gpt-5.6-sol": "openai-gpt-5.6-sol",
  "gemini-3.6-flash": "vertex-gemini-3.6-flash",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "default": "anthropic-sonnet-3.5-stable"
};

let currentTokenIndex = 0;

function getNextNotionToken() {
  if (!NOTION_TOKENS.length) {
    loadTokens();
    if (!NOTION_TOKENS.length) throw new Error("No Notion tokens available.");
  }
  const token = NOTION_TOKENS[currentTokenIndex];
  currentTokenIndex = (currentTokenIndex + 1) % NOTION_TOKENS.length;
  return token;
}

// ── WORKSPACE CREATOR ────────────────────────────────────────────────────

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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Origin': 'https://www.notion.so',
        'Referer': 'https://www.notion.so/',
        'x-notion-active-user-header': userId
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 429) {
          console.error('[PROXY] createSpace hit Rate Limit.');
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

// ── ACCOUNT RESOLVER ────────────────────────────────────────────────────

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
    const req = https.request({
      hostname: 'www.notion.so',
      port: 443,
      path: '/api/v3/getSpaces',
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '2',
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
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
            console.log(`[PROXY] No space for ${userId}, creating...`);
            spaceId = await createSpace(rawToken, userId, proxyUrl);
          }

          if (userId && spaceId) {
            console.log(`[PROXY] User: ${userId} | Space: ${spaceId}`);
            return resolve({ spaceId, userId });
          }
          reject(new Error('No workspace found or created.'));
        } catch (e) {
          reject(new Error(`Failed to parse getSpaces: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write('{}');
    req.end();
  });
}

// ── NOTION AI REQUEST – NEW PAYLOAD SCHEMA ─────────────────────────────

async function fetchNotionAI(payload, rawToken, userId, proxyUrl, spaceId) {
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

  const tlsAgent = new https.Agent({
    secureOptions: crypto.constants.SSL_OP_NO_SSLv3 | crypto.constants.SSL_OP_NO_TLSv1 | crypto.constants.SSL_OP_NO_TLSv1_1,
    ciphers: [
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'TLS_AES_128_GCM_SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-CHACHA20-POLY1305',
      'ECDHE-RSA-AES128-SHA',
      'ECDHE-RSA-AES256-SHA'
    ].join(':'),
    honorCipherOrder: true
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.notion.so',
      port: 443,
      path: '/api/v3/runInferenceTranscript',
      method: 'POST',
      agent: agent || tlsAgent,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/x-ndjson',
        'Content-Length': Buffer.byteLength(postData),
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Origin': 'https://www.notion.so',
        'Referer': 'https://www.notion.so/',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Google Chrome";v="126", "Chromium";v="126"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Priority': 'u=1, i',
        'TE': 'trailers',
        'Connection': 'keep-alive',
        'x-notion-active-user-header': userId,
        'x-notion-space-id': spaceId,
        'x-notion-client-version': '23.13.20260802.1530',
        'notion-audit-log-platform': 'web'
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
  // Build a single prompt string (the AI expects transcript as a string)
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

// ── PARSER (unchanged) ──────────────────────────────────────────────────

function extractTextFromData(data) {
  if (data.text) return data.text;
  if (data.delta) return data.delta;
  if (data.type === 'markdown-chat') return data.value || '';
  if (data.type === 'patch' && Array.isArray(data.v)) {
    let acc = '';
    for (const op of data.v) {
      if (!op || typeof op !== 'object') continue;
      const opType = op.o;
      const path = Array.isArray(op.p) ? op.p.join('/') : (op.p || '');
      const val = op.v;
      if (opType === 'a' && path.endsWith('/s/-') && val && val.type === 'markdown-chat') {
        if (val.value) acc += val.value;
      } else if (opType === 'x' && path.includes('/s/') && path.endsWith('/value') && typeof val === 'string') {
        acc += val;
      } else if (opType === 'x' && path.includes('/value/') && typeof val === 'string') {
        acc += val;
      } else if (opType === 'a' && path.endsWith('/value/-') && val && val.type === 'text') {
        if (val.content) acc += val.content;
      }
    }
    return acc;
  }
  if (data.type === 'record-map' && data.recordMap) {
    const rm = data.recordMap;
    if (rm.thread_message) {
      let acc = '';
      for (const msgId in rm.thread_message) {
        const msg = rm.thread_message[msgId];
        const step = msg?.value?.value?.step;
        if (!step) continue;
        if (step.type === 'markdown-chat' && step.value) acc += step.value;
        else if (step.type === 'agent-inference' && Array.isArray(step.value)) {
          for (const item of step.value) {
            if (item && item.type === 'text' && item.content) {
              acc += item.content;
              break;
            }
          }
        }
      }
      return acc;
    }
  }
  if (data.type === 'text' && data.value) return data.value;
  return '';
}

function parseNotionResponse(rawBuffer) {
  const trimmed = rawBuffer.trim();
  if (trimmed.startsWith('[')) {
    try {
      const array = JSON.parse(trimmed);
      let full = '';
      for (const item of array) {
        const text = extractTextFromData(item);
        if (text) full += text;
      }
      return full;
    } catch (e) { /* fall through */ }
  }
  const lines = trimmed.split('\n').filter(line => line.trim() !== '');
  let full = '';
  for (const line of lines) {
    try {
      const data = JSON.parse(line);
      const text = extractTextFromData(data);
      if (text) full += text;
    } catch (e) { /* skip */ }
  }
  return full;
}

// ── OPENAI ROUTES ──────────────────────────────────────────────────────

app.get('/v1/models', (req, res) => {
  res.json({
    object: "list",
    data: Object.keys(MODEL_MAP).map(m => ({
      id: m,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "notion-ai"
    }))
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  const completionId = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const requestedModel = req.body.model || "claude-fable-5";
  const notionModel = MODEL_MAP[requestedModel.toLowerCase()] || "anthropic-sonnet-3.5-stable";
  const stream = req.body.stream !== undefined ? req.body.stream : true;

  const promptText = packMessagesForNotion(req.body.messages || []);
  const tokenCookie = getNextNotionToken();
  const proxyUrl = process.env.ROTATING_PROXY_URL || undefined;

  try {
    let accountInfo = accountCache.get(tokenCookie);
    if (!accountInfo) {
      accountInfo = await getNotionAccountInfo(tokenCookie, proxyUrl);
      accountCache.set(tokenCookie, accountInfo);
    }

    // ── NEW PAYLOAD STRUCTURE ──────────────────────────────────────────
    // We need a pageId – if not available, generate a random one (may fail)
    // In the future, we could fetch a real page from the workspace
    const pageId = crypto.randomUUID(); // placeholder

    const notionPayload = {
      task: "inference",                // or "conversation" – adjust as needed
      model: notionModel,
      context: {
        type: "transcript",
        pageId: pageId,
        spaceId: accountInfo.spaceId
      },
      transcript: promptText,           // now a plain string
      traceId: crypto.randomUUID()
    };

    console.log(`[REQUEST] Model: ${requestedModel} → ${notionModel} | Space: ${accountInfo.spaceId}`);
    console.log('[DEBUG] Payload:', JSON.stringify(notionPayload, null, 2));

    const notionRes = await fetchNotionAI(notionPayload, tokenCookie, accountInfo.userId, proxyUrl, accountInfo.spaceId);

    console.log(`[DEBUG] Status: ${notionRes.statusCode}`);

    if (notionRes.statusCode >= 400) {
      let body = '';
      notionRes.on('data', d => body += d);
      notionRes.on('end', () => {
        console.error(`[NOTION ERROR ${notionRes.statusCode}]`, body);
        res.status(notionRes.statusCode).json({ error: `Notion Error ${notionRes.statusCode}`, details: body });
      });
      return;
    }

    // ── Read response ──────────────────────────────────────────────────
    let fullBuffer = '';
    notionRes.on('data', chunk => { fullBuffer += chunk.toString(); });

    await new Promise((resolve, reject) => {
      notionRes.on('end', resolve);
      notionRes.on('error', reject);
    });

    const fullContent = parseNotionResponse(fullBuffer);
    console.log(`[DEBUG] Extracted content length: ${fullContent.length}`);

    const responseData = {
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: fullContent || '(empty response)'
        },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);
      if (fullContent) {
        res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { content: fullContent } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json(responseData);
    }

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
