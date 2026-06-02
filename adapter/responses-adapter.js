'use strict';
/**
 * Responses proxy / adapter.
 *
 * Two modes:
 *  - passthrough (opts.passthrough=true): the upstream relay natively speaks the
 *    OpenAI Responses API. We forward POST /responses verbatim and only swap the
 *    Authorization header, so every native tool (web_search, etc.) works and the
 *    real upstream key never leaves this process.
 *  - translate (default): the upstream only speaks Chat Completions (e.g. GLM).
 *    We translate the runtime's POST /responses (SSE) into an upstream
 *    /chat/completions streaming call and re-emit Responses SSE events.
 *
 * It is intentionally dependency-free so it can be bundled inside Electron and
 * later reused as the core of the production relay.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// ---- Responses request -> Chat Completions request -------------------------

function partsToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p.text === 'string') return p.text;
      return '';
    })
    .join('');
}

// GLM / generic chat backends only understand system|user|assistant|tool.
function normalizeRole(role) {
  if (role === 'developer') return 'system';
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') return role;
  return 'user';
}

function buildChatMessages(reqBody) {
  const messages = [];
  if (reqBody.instructions) {
    messages.push({ role: 'system', content: String(reqBody.instructions) });
  }
  if (typeof reqBody.input === 'string' && reqBody.input.trim()) {
    messages.push({ role: 'user', content: reqBody.input });
    return messages;
  }
  const input = Array.isArray(reqBody.input) ? reqBody.input : [];
  for (const item of input) {
    if (typeof item === 'string') {
      if (item.trim()) messages.push({ role: 'user', content: item });
      continue;
    }
    const type = item.type || 'message';
    if (type === 'message') {
      messages.push({ role: normalizeRole(item.role), content: partsToText(item.content) });
    } else if (type === 'function_call') {
      // assistant requested a tool call previously
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: item.call_id || item.id || genId('call'),
            type: 'function',
            function: { name: item.name, arguments: item.arguments || '{}' },
          },
        ],
      });
    } else if (type === 'function_call_output') {
      const out = item.output;
      const text = typeof out === 'string' ? out : partsToText(out && out.content) || JSON.stringify(out);
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: text });
    }
    // reasoning / other item types are dropped for upstream chat compatibility
  }
  return messages;
}

function buildChatTools(reqBody) {
  const tools = Array.isArray(reqBody.tools) ? reqBody.tools : [];
  const out = [];
  for (const t of tools) {
    // Only forward plain function tools. Runtime-specific tools such as the
    // `namespace` multi-agent tool or the typed `web_search` tool are not
    // understood by chat backends and would cause 400s.
    if (t && t.type === 'function' && t.name) {
      out.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

function buildChatRequest(reqBody, model) {
  const body = {
    model: model || reqBody.model,
    messages: buildChatMessages(reqBody),
    stream: true,
  };
  const tools = buildChatTools(reqBody);
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = reqBody.tool_choice || 'auto';
  }
  return body;
}

// ---- SSE writer for the Responses stream the runtime consumes --------------

function makeResponsesWriter(res, responseId) {
  function send(type, payload) {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  }
  let itemOpen = false;
  function ensureItemOpen() {
    if (itemOpen) return;
    itemOpen = true;
    // The runtime requires an active output item before it accepts text deltas;
    // without this it logs "OutputTextDelta without active item" and drops the
    // streamed tokens (so no live streaming in the UI).
    send('response.output_item.added', {
      output_index: 0,
      item: { id: 'msg_0', type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    });
  }
  return {
    created() {
      send('response.created', { response: { id: responseId, object: 'response', status: 'in_progress' } });
    },
    outputTextDelta(delta) {
      if (!delta) return;
      ensureItemOpen();
      send('response.output_text.delta', { item_id: 'msg_0', output_index: 0, content_index: 0, delta });
    },
    messageDone(text) {
      ensureItemOpen();
      send('response.output_item.done', {
        output_index: 0,
        item: { id: 'msg_0', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: text || '' }] },
      });
    },
    functionCallDone(call, index) {
      send('response.output_item.done', {
        output_index: index,
        item: {
          type: 'function_call',
          name: call.name,
          arguments: call.arguments || '{}',
          call_id: call.id || genId('call'),
        },
      });
    },
    completed(usage) {
      const u = usage || {};
      send('response.completed', {
        response: {
          id: responseId,
          object: 'response',
          status: 'completed',
          usage: {
            input_tokens: u.prompt_tokens || 0,
            output_tokens: u.completion_tokens || 0,
            total_tokens: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      });
    },
    failed(message) {
      send('response.failed', { response: { id: responseId, status: 'failed', error: { message: String(message) } } });
    },
  };
}

// ---- Upstream chat call ----------------------------------------------------

function postUpstream(baseUrl, apiKey, body) {
  const url = new URL(baseUrl.replace(/\/$/, '') + '/chat/completions');
  const mod = url.protocol === 'https:' ? https : http;
  const data = JSON.stringify(body);
  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Accept: 'text/event-stream',
      'Content-Length': Buffer.byteLength(data),
    },
  };
  return new Promise((resolve, reject) => {
    const r = mod.request(options, (resp) => resolve(resp));
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

// ---- Transparent Responses passthrough -------------------------------------
// When the upstream relay natively speaks the OpenAI Responses API we forward the
// runtime's request verbatim and only swap the Authorization header. This keeps
// all native tools (web_search, etc.) intact and keeps the real upstream key in
// this process only — the runtime authenticates with an ephemeral localhost
// token, so nothing sensitive lives in the runtime's (shell-inheritable) env.
function postUpstreamResponses(baseUrl, apiKey, incomingHeaders, rawBody) {
  const url = new URL(baseUrl.replace(/\/$/, '') + '/responses');
  const mod = url.protocol === 'https:' ? https : http;
  const headers = {};
  for (const [k, v] of Object.entries(incomingHeaders || {})) {
    const key = k.toLowerCase();
    if (key === 'host' || key === 'authorization' || key === 'content-length' || key === 'connection') continue;
    headers[k] = v;
  }
  headers['Authorization'] = `Bearer ${apiKey}`;
  if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  if (!headers['Accept'] && !headers['accept']) headers['Accept'] = 'text/event-stream';
  headers['Content-Length'] = Buffer.byteLength(rawBody);
  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    headers,
  };
  return new Promise((resolve, reject) => {
    const r = mod.request(options, (resp) => resolve(resp));
    r.on('error', reject);
    r.write(rawBody);
    r.end();
  });
}

// ---- Stream translation ----------------------------------------------------

async function streamTranslate(upstreamResp, writer) {
  return new Promise((resolve) => {
    let buf = '';
    let fullText = '';
    let usage = null;
    const toolCalls = []; // index -> {id,name,arguments}
    let finished = false;

    function finish() {
      if (finished) return;
      finished = true;
      if (fullText) writer.messageDone(fullText);
      let idx = 1;
      for (const c of toolCalls) {
        if (c && (c.name || c.arguments)) writer.functionCallDone(c, idx++);
      }
      writer.completed(usage);
      resolve();
    }

    function handleChunk(obj) {
      if (obj.usage) usage = obj.usage;
      const choice = obj.choices && obj.choices[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        fullText += delta.content;
        writer.outputTextDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index != null ? tc.index : 0;
          if (!toolCalls[i]) toolCalls[i] = { id: tc.id, name: '', arguments: '' };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function) {
            if (tc.function.name) toolCalls[i].name = tc.function.name;
            if (tc.function.arguments) toolCalls[i].arguments += tc.function.arguments;
          }
        }
      }
    }

    upstreamResp.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          finish();
          return;
        }
        try {
          handleChunk(JSON.parse(payload));
        } catch (_) {
          /* ignore partial/non-json keepalives */
        }
      }
    });
    upstreamResp.on('end', finish);
    upstreamResp.on('error', () => finish());
  });
}

// ---- Server ----------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.upstreamBaseUrl - API root, e.g. https://host/v1
 * @param {function():string} opts.getApiKey - returns upstream bearer key
 * @param {string} [opts.token] - per-session bearer token the adapter requires
 * @param {boolean} [opts.passthrough] - forward /responses verbatim (relay is Responses-native)
 * @param {string} [opts.model] - force a model override (translate mode only)
 * @param {function} [opts.log]
 */
function createAdapterServer(opts) {
  const log = opts.log || (() => {});
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.method !== 'POST' || !req.url.startsWith('/responses')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (opts.token) {
      const auth = req.headers['authorization'] || '';
      if (auth !== `Bearer ${opts.token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      // Transparent passthrough: forward the runtime's Responses request to a
      // Responses-native relay untouched (preserves web_search and all tools).
      if (opts.passthrough) {
        try {
          const upstream = await postUpstreamResponses(
            opts.upstreamBaseUrl,
            opts.getApiKey(),
            req.headers,
            body,
          );
          const headers = { ...upstream.headers };
          delete headers['content-length'];
          delete headers['transfer-encoding'];
          if (!headers['content-type'] && !headers['Content-Type']) {
            headers['Content-Type'] = 'text/event-stream';
          }
          res.writeHead(upstream.statusCode || 200, headers);
          if ((upstream.statusCode || 200) >= 400) {
            log('upstream responses error', upstream.statusCode);
          }
          upstream.pipe(res);
        } catch (e) {
          log('passthrough error', e && e.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e && e.message ? e.message : 'passthrough error' } }));
        }
        return;
      }

      let reqBody;
      try {
        reqBody = JSON.parse(body);
      } catch (e) {
        res.writeHead(400);
        res.end('bad json');
        return;
      }
      const responseId = genId('resp');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const writer = makeResponsesWriter(res, responseId);
      writer.created();
      try {
        const chatReq = buildChatRequest(reqBody, opts.model);
        log('upstream chat request', { model: chatReq.model, messages: chatReq.messages.length, tools: (chatReq.tools || []).length });
        const upstream = await postUpstream(opts.upstreamBaseUrl, opts.getApiKey(), chatReq);
        if (upstream.statusCode >= 400) {
          let errBody = '';
          upstream.on('data', (c) => (errBody += c));
          upstream.on('end', () => {
            log('upstream error', upstream.statusCode, errBody.slice(0, 500));
            writer.failed(`upstream ${upstream.statusCode}: ${errBody.slice(0, 300)}`);
            res.end();
          });
          return;
        }
        await streamTranslate(upstream, writer);
        res.end();
      } catch (e) {
        log('adapter error', e && e.message);
        writer.failed(e && e.message ? e.message : 'adapter error');
        res.end();
      }
    });
  });
  return server;
}

module.exports = { createAdapterServer, buildChatRequest, buildChatMessages, buildChatTools };

// Allow standalone run for testing: node adapter/responses-adapter.js
if (require.main === module) {
  const port = parseInt(process.env.ADAPTER_PORT || '8898', 10);
  const server = createAdapterServer({
    upstreamBaseUrl: process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/coding/paas/v4',
    getApiKey: () => process.env.GLM_API_KEY || '',
    model: process.env.ADAPTER_MODEL || 'glm-4.6',
    token: process.env.ADAPTER_TOKEN || '',
    log: (...a) => console.error('[adapter]', ...a),
  });
  server.listen(port, '127.0.0.1', () => console.error(`[adapter] listening on 127.0.0.1:${port}`));
}
