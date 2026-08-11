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
    console.warn(`[WARNING] notion-tokens.txt not found.`);
    NOTION_TOKENS = [];
  }
}

// ── EXPANDED MODEL MAPPING ──────────────────────────────────────────────────
const MODEL_MAP = {
  // Anthropic
  "claude-fable-5": "claude-fable-5",
  "fable-5": "claude-fable-5",
  "claude-sonnet-5": "anthropic-sonnet-3.x-stable",
  "claude-opus-5": "anthropic-opus-4.8",

  // OpenAI
  "gpt-5.6-sol": "openai-gpt-5.6-sol",
  "gpt-5.5": "openai-gpt-5.5",
  "gpt-5.4": "openai-gpt-5.4",
  "gpt-4o": "openai-gpt-4o",

  // Google
  "gemini-3.6-flash": "vertex-gemini-3.6-flash",

  // DeepSeek
  "deepseek-v4-pro": "deepseek-v4-pro",

  // Other Common Models
  "grok-4.5": "grok-4.5",
  "kimi-k2.6": "kimi-k2.6",
  "glm-5.2": "glm-5.2",
  "qwen3.8-max": "qwen3.8-max",
  "default": "anthropic-sonnet-3.x-stable"
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

// ── HTTP PROXY TRANSPORT (UPDATED HEADERS) ─────────────────────────────────

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

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.notion.so',
      port: 443,
      path: '/api/v3/runInferenceTranscript',
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/x-ndjson',
        'Content-Length': Buffer.byteLength(postData),
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://www.notion.so',
        'Referer': 'https://www.notion.so/',
        'x-notion-active-user-header': userId,
        'x-notion-space-id': spaceId,
        'x-notion-client-version': '23.13.20260313.1423',
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

// ── HELPER: DEEP NESTED STREAM PARSER ──────────────────────────────────────

function parseNotionLine(line) {
  try {
    const data = JSON.parse(line);

    // 1. Direct old format fallbacks
    if (data.text) return data.text;
    if (data.delta) return data.delta;

    // 2. Direct markdown-chat events
    if (data.type === 'markdown-chat') {
      return data.value || '';
    }

    // 3. Patches (Claude, GPT, and Gemini stream formats)
    if (data.type === 'patch' && Array.isArray(data.v)) {
      let accumulatedText = '';
      for (const op of data.v) {
        if (!op || typeof op !== 'object') continue;
        
        const opType = op.o; // operation command ('a' or 'x')
        const path = Array.isArray(op.p) ? op.p.join('/') : (op.p || '');
        const val = op.v;

        // Gemini full content patch
        if (opType === 'a' && path.endsWith('/s/-') && val && val.type === 'markdown-chat') {
          if (val.value) accumulatedText += val.value;
        }
        // Gemini incremental patch
        else if (opType === 'x' && path.includes('/s/') && path.endsWith('/value') && typeof val === 'string') {
          accumulatedText += val;
        }
        // Claude and GPT incremental patch
        else if (opType === 'x' && path.includes('/value/') && typeof val === 'string') {
          accumulatedText += val;
        }
        // Claude and GPT full content patch
        else if (opType === 'a' && path.endsWith('/value/-') && val && val.type === 'text') {
          if (val.content) accumulatedText += val.content;
        }
      }
      return accumulatedText;
    }

    // 4. Nested record-map data
    if (data.type === 'record-map' && data.recordMap) {
      const recordMap = data.recordMap;
      if (recordMap.thread_message) {
        let accumulatedText = '';
        for (const msgId in recordMap.thread_message) {
          const msgData = recordMap.thread_message[msgId];
          const valueData = msgData?.value?.value;
          const step = valueData?.step;
          if (!step) continue;

          if (step.type === 'markdown-chat') {
            if (step.value) accumulatedText += step.value;
          } else if (step.type === 'agent-inference') {
            const agentValues = step.value;
            if (Array.isArray(agentValues)) {
              for (const item of agentValues) {
                if (item && item.type === 'text' && item.content) {
                  accumulatedText += item.content;
                  break;
                }
              }
            }
          }
        }
        return accumulatedText;
      }
    }

    // 5. Raw text fallback
    if (data.type === 'text' && data.value) {
      return data.value;
    }
  } catch (err) {
    // Silently skip incomplete JSON splits
  }
  return '';
}

// ── OPENAI ROUTES ────────────────────────────────────────────────────────────

// Dynamic list of all mapped models
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
  const notionModel = MODEL_MAP[requestedModel.toLowerCase()] || "anthropic-sonnet-3.x-stable";
  const stream = req.body.stream !== undefined ? req.body.stream : true; // default true

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
    const notionPayload = {
      traceId: crypto.randomUUID(),
      spaceId: accountInfo.spaceId,
      threadId: threadId,
      createThread: true,
      isPartialTranscript: true,
      asPatchResponse: true,
      generateTitle: false,
      saveAllThreadOperations: true,
      threadType: "markdown-chat",
      transcript: [
        {
          id: crypto.randomUUID(),
          type: "config",
          value: {
            type: "thread",
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
      ]
    };

    console.log(`[REQUEST] Model: ${requestedModel} → ${notionModel} | Space: ${accountInfo.spaceId}`);

    const notionRes = await fetchNotionAI(notionPayload, tokenCookie, accountInfo.userId, proxyUrl, accountInfo.spaceId);

    if (notionRes.statusCode >= 400) {
      let body = '';
      notionRes.on('data', d => body += d);
      notionRes.on('end', () => {
        console.error(`[NOTION ERROR ${notionRes.statusCode}]`, body);
        res.status(notionRes.statusCode).json({ error: `Notion Error ${notionRes.statusCode}`, details: body });
      });
      return;
    }

    // ── Read the entire NDJSON stream into a buffer ──────────────────────
    let fullBuffer = '';
    notionRes.on('data', chunk => { fullBuffer += chunk.toString(); });

    await new Promise((resolve, reject) => {
      notionRes.on('end', resolve);
      notionRes.on('error', reject);
    });

    // ── Parse all lines to extract the complete answer ────────────────────
    const lines = fullBuffer.split('\n').filter(line => line.trim() !== '');
    let fullContent = '';
    for (const line of lines) {
      const chunk = parseNotionLine(line);
      if (chunk) fullContent += chunk;
    }

    // ── If no content was extracted, log raw response for debugging ──────
    if (!fullContent) {
      console.warn('[WARNING] No content extracted from Notion. Raw NDJSON:', fullBuffer);
    }

    // ── Build the final completion ─────────────────────────────────────────
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

    // ── Send either stream or standard JSON ──────────────────────────────
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Simulate streaming by sending the whole content in one chunk
      // (you could also split it into tokens if desired)
      res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);
      if (fullContent) {
        res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { content: fullContent } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // Standard JSON response
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
