'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { HttpProxyAgent } = require('http-proxy-agent');

const { NetworkModifier } = require('../src');
const { isLikelyEmailTraffic } = require('../src/proxy');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netmod-test-'));

let app;
let origin;
let secureOrigin;
let originUrl;
let secureOriginUrl;
let lastRequest;

function startOrigin() {
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastRequest = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      if (req.url.startsWith('/gzip')) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        return res.end(zlib.gzipSync(Buffer.from(JSON.stringify({ compressed: true }))));
      }
      if (req.url.startsWith('/echo')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: lastRequest.body }));
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'x-origin': 'yes' });
      res.end('original body');
    });
  };
  return handler;
}

test.before(async () => {
  origin = http.createServer(startOrigin());
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  originUrl = `http://127.0.0.1:${origin.address().port}`;

  app = new NetworkModifier({
    dataDir,
    overrides: { proxyPort: 0, uiPort: 0, host: '127.0.0.1' }
  });

  const leaf = app.ca.leafFor('localhost');
  secureOrigin = https.createServer({ key: leaf.key, cert: leaf.cert }, startOrigin());
  await new Promise((resolve) => secureOrigin.listen(0, '127.0.0.1', resolve));
  secureOriginUrl = `https://localhost:${secureOrigin.address().port}`;

  await app.start();
});

test.after(async () => {
  http.globalAgent.destroy();
  https.globalAgent.destroy();
  await app.stop();
  origin.close();
  origin.closeAllConnections();
  secureOrigin.close();
  secureOrigin.closeAllConnections();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function setRules(rules) {
  app.config.rules = rules;
  app.ruleEngine.setRules(rules);
}

function proxyRequest(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const req = http.request({
      host: '127.0.0.1',
      port: app.config.settings.proxyPort,
      method: options.method || 'GET',
      path: targetUrl,
      headers: { host: target.host, ...(options.headers || {}) }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function proxyTlsRequest(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const connectReq = http.request({
      host: '127.0.0.1',
      port: app.config.settings.proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port}`
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`CONNECT failed: ${res.statusCode}`));
      const secured = tls.connect({
        socket,
        servername: target.hostname,
        ca: [app.ca.caCertPem]
      }, () => {
        const req = https.request({
          createConnection: () => secured,
          method: options.method || 'GET',
          path: target.pathname + target.search,
          headers: { host: target.host, ...(options.headers || {}) }
        }, (response) => {
          const chunks = [];
          response.on('data', (c) => chunks.push(c));
          response.on('end', () => {
            secured.end();
            resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() });
          });
        });
        req.on('error', reject);
        req.end();
      });
      secured.on('error', reject);
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

function uiRequest(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: app.config.settings.uiPort,
      method: options.method || 'GET',
      path: pathname,
      headers: { 'content-type': 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : {} });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

/* --------------------------------------------------------------------- tests */

test('recognizes email traffic that must bypass HTTPS interception', () => {
  assert.equal(isLikelyEmailTraffic('exchange.example.test', 993), true);
  assert.equal(isLikelyEmailTraffic('autodiscover.example.test', 443), true);
  assert.equal(isLikelyEmailTraffic('login.microsoftonline.com', 443), true);
  assert.equal(isLikelyEmailTraffic('api.example.test', 443), false);
});

test('passes plain HTTP traffic through and captures it', async () => {
  setRules([]);
  const response = await proxyRequest(`${originUrl}/plain`);
  assert.equal(response.status, 200);
  assert.equal(response.body, 'original body');
  const flows = app.store.list();
  assert.ok(flows.some((f) => f.url.endsWith('/plain')));
});

test('adds, replaces and removes request headers', async () => {
  setRules([{
    name: 'headers',
    enabled: true,
    match: { urlPattern: '/echo', matchType: 'contains' },
    actions: [
      { type: 'set-request-header', name: 'x-added', value: 'from-rule' },
      { type: 'remove-request-header', name: 'x-drop-me' }
    ]
  }]);
  await proxyRequest(`${originUrl}/echo`, { headers: { 'x-drop-me': '1' } });
  assert.equal(lastRequest.headers['x-added'], 'from-rule');
  assert.equal(lastRequest.headers['x-drop-me'], undefined);
});

test('applies only active rule profiles in priority order', async () => {
  app.ruleEngine.setActiveProfiles(['staging']);
  setRules([
    { name: 'low', profile: 'staging', priority: 1, enabled: true, match: {}, actions: [{ type: 'set-request-header', name: 'x-priority', value: 'low' }] },
    { name: 'inactive', profile: 'default', priority: 100, enabled: true, match: {}, actions: [{ type: 'set-request-header', name: 'x-priority', value: 'inactive' }] },
    { name: 'high', profile: 'staging', priority: 10, enabled: true, match: {}, actions: [{ type: 'set-request-header', name: 'x-priority', value: 'high' }] }
  ]);
  await proxyRequest(`${originUrl}/echo`);
  assert.equal(lastRequest.headers['x-priority'], 'low');

  app.ruleEngine.setActiveProfiles(['*']);
  setRules([
    { name: 'default', profile: 'default', enabled: true, match: {}, actions: [{ type: 'set-request-header', name: 'x-default-profile', value: 'yes' }] },
    { name: 'staging', profile: 'staging', enabled: true, match: {}, actions: [{ type: 'set-request-header', name: 'x-staging-profile', value: 'yes' }] }
  ]);
  await proxyRequest(`${originUrl}/echo`);
  assert.equal(lastRequest.headers['x-default-profile'], 'yes');
  assert.equal(lastRequest.headers['x-staging-profile'], 'yes');
  app.ruleEngine.setActiveProfiles(['*']);
});

test('redirects a request to an arbitrary URL', async () => {
  setRules([{
    name: 'redirect',
    enabled: true,
    match: { urlPattern: '*/old/*', matchType: 'wildcard' },
    actions: [{ type: 'redirect', url: `${originUrl}/echo?moved=$2` }]
  }]);
  const response = await proxyRequest(`${originUrl}/old/thing`);
  const payload = JSON.parse(response.body);
  assert.match(payload.url, /^\/echo\?moved=thing$/);
});

test('replaces the request body with JSON', async () => {
  setRules([{
    name: 'body',
    enabled: true,
    match: { urlPattern: '/echo', matchType: 'contains' },
    actions: [{ type: 'set-request-body', bodyType: 'json', value: '{"replaced":true}' }]
  }]);
  const response = await proxyRequest(`${originUrl}/echo`, { method: 'POST', body: 'original' });
  const payload = JSON.parse(response.body);
  assert.equal(payload.body, '{"replaced":true}');
  assert.match(payload.headers['content-type'], /application\/json/);
  const flow = app.store.flows.at(-1);
  assert.equal(flow.originalRequest.body.toString(), 'original');
  assert.equal(flow.request.body.toString(), '{"replaced":true}');
});

test('replaces the response status, headers and body', async () => {
  setRules([{
    name: 'response',
    enabled: true,
    match: { urlPattern: '/plain', matchType: 'contains' },
    actions: [
      { type: 'set-status', status: 503, statusMessage: 'Nope' },
      { type: 'set-response-header', name: 'x-injected', value: 'yes' },
      { type: 'remove-response-header', name: 'x-origin' },
      { type: 'set-response-body', bodyType: 'text', value: 'replaced body' }
    ]
  }]);
  const response = await proxyRequest(`${originUrl}/plain`);
  assert.equal(response.status, 503);
  assert.equal(response.headers['x-injected'], 'yes');
  assert.equal(response.headers['x-origin'], undefined);
  assert.equal(response.body, 'replaced body');
  const flow = app.store.flows.at(-1);
  assert.equal(flow.originalResponse.body.toString(), 'original body');
  assert.equal(flow.response.body.toString(), 'replaced body');
});

test('replaces the response body from base64 and a file', async () => {
  const file = path.join(dataDir, 'local.txt');
  fs.writeFileSync(file, 'from disk');
  setRules([
    {
      name: 'b64',
      enabled: true,
      match: { urlPattern: '/plain', matchType: 'contains' },
      actions: [{ type: 'set-response-body', bodyType: 'base64', value: Buffer.from('b64 body').toString('base64') }]
    }
  ]);
  assert.equal((await proxyRequest(`${originUrl}/plain`)).body, 'b64 body');

  setRules([{
    name: 'map local',
    enabled: true,
    match: { urlPattern: '/plain', matchType: 'contains' },
    actions: [{ type: 'map-local', path: file }]
  }]);
  const mapped = await proxyRequest(`${originUrl}/plain`);
  assert.equal(mapped.body, 'from disk');
});

test('mocks a response without touching the network', async () => {
  setRules([{
    name: 'mock',
    enabled: true,
    match: { urlPattern: '/never', matchType: 'contains' },
    actions: [{ type: 'mock-response', status: 201, bodyType: 'json', value: '{"mock":1}' }]
  }]);
  lastRequest = null;
  const response = await proxyRequest(`${originUrl}/never`);
  assert.equal(response.status, 201);
  assert.deepEqual(JSON.parse(response.body), { mock: 1 });
  assert.equal(lastRequest, null);
});

test('adds an extra response delay', async () => {
  setRules([{
    name: 'delay',
    enabled: true,
    match: { urlPattern: '/plain', matchType: 'contains' },
    actions: [{ type: 'delay-response', ms: 300 }]
  }]);
  const started = Date.now();
  await proxyRequest(`${originUrl}/plain`);
  assert.ok(Date.now() - started >= 290, 'expected the response to be delayed');
});

test('cancels a request on the client', async () => {
  setRules([{
    name: 'block',
    enabled: true,
    match: { urlPattern: '/plain', matchType: 'contains' },
    actions: [{ type: 'cancel', reason: 'blocked by test' }]
  }]);
  await assert.rejects(() => proxyRequest(`${originUrl}/plain`));
  const flow = app.store.list().reverse().find((f) => f.state === 'cancelled');
  assert.equal(flow.error, 'blocked by test');
});

test('filters by method and resource type', async () => {
  setRules([{
    name: 'only POST xhr',
    enabled: true,
    match: { urlPattern: '', matchType: 'contains', methods: ['POST'], resourceTypes: ['xhr'] },
    actions: [{ type: 'set-request-header', name: 'x-filtered', value: 'yes' }]
  }]);
  await proxyRequest(`${originUrl}/echo`);
  assert.equal(lastRequest.headers['x-filtered'], undefined);
  await proxyRequest(`${originUrl}/echo`, { method: 'POST', body: '{}' });
  assert.equal(lastRequest.headers['x-filtered'], 'yes');
});

test('classifies browser traffic separately from other clients', async () => {
  setRules([]);
  await proxyRequest(`${originUrl}/plain`);
  await proxyRequest(`${originUrl}/plain`, {
    headers: {
      'user-agent': 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
      'sec-fetch-mode': 'navigate'
    }
  });
  const stored = app.store.flows.slice(-2);
  delete stored[0].clientSource;
  delete stored[1].clientSource;
  const flows = app.store.list().slice(-2);
  assert.equal(flows[0].clientSource, 'other');
  assert.equal(flows[1].clientSource, 'browser');
});

test('runs user scripts on request and response', async () => {
  setRules([{
    name: 'script',
    enabled: true,
    match: { urlPattern: '/echo', matchType: 'contains' },
    actions: [{
      type: 'script',
      code: `
        if (ctx.phase === 'request') {
          ctx.request.setHeader('x-script', 'ran');
        } else {
          const data = ctx.response.json;
          data.scripted = true;
          ctx.response.json = data;
          ctx.response.status = 202;
        }
      `
    }]
  }]);
  const response = await proxyRequest(`${originUrl}/echo`);
  assert.equal(response.status, 202);
  assert.equal(JSON.parse(response.body).scripted, true);
  assert.equal(lastRequest.headers['x-script'], 'ran');
});

test('decodes gzip responses so they can be edited', async () => {
  setRules([{
    name: 'gzip edit',
    enabled: true,
    match: { urlPattern: '/gzip', matchType: 'contains' },
    actions: [{ type: 'script', code: `if (ctx.phase === 'response') { ctx.response.body = ctx.response.body.toUpperCase(); }` }]
  }]);
  const response = await proxyRequest(`${originUrl}/gzip`);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(response.body, '{"COMPRESSED":TRUE}');
});

test('intercepts HTTPS through CONNECT with a generated certificate', async () => {
  setRules([{
    name: 'https',
    enabled: true,
    match: { urlPattern: '/plain', matchType: 'contains', protocol: 'https' },
    actions: [{ type: 'set-response-header', name: 'x-mitm', value: 'ok' }]
  }]);
  const response = await proxyTlsRequest(`${secureOriginUrl}/plain`);
  assert.equal(response.status, 200, response.body);
  assert.equal(response.headers['x-mitm'], 'ok');
  assert.equal(response.body, 'original body');
});

test('captures and resends editable WebSocket frames', async (context) => {
  const server = http.createServer();
  const webSockets = new WebSocketServer({ server });
  context.after(() => {
    for (const socket of webSockets.clients) socket.terminate();
    webSockets.close();
    server.closeAllConnections();
    server.close();
  });
  webSockets.on('connection', (socket) => socket.on('message', (data, binary) => socket.send(data, { binary })));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const target = `ws://127.0.0.1:${server.address().port}/echo`;
  const client = new WebSocket(target, { agent: new HttpProxyAgent(`http://127.0.0.1:${app.config.settings.proxyPort}`) });
  const messages = [];
  client.on('message', (data) => messages.push(data.toString()));
  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  client.send('first-frame');
  await new Promise((resolve) => client.once('message', resolve));
  const targetHttp = target.replace(/^ws:/, 'http:');
  const flow = app.store.flows.find((item) => item.resourceType === 'websocket' && item.request.url === targetHttp);
  assert.ok(flow.webSocketFrames.some((frame) => frame.data === 'first-frame'));
  const editedMessage = new Promise((resolve) => client.once('message', resolve));
  const sent = await uiRequest(`/api/flows/${flow.id}/websocket-frame`, {
    method: 'POST', body: { direction: 'server-to-client', data: 'edited-frame', binary: false }
  });
  assert.equal(sent.status, 200);
  await editedMessage;
  assert.ok(messages.includes('edited-frame'));
  client.close();
});

test('routes matching requests through an upstream HTTP proxy', async (context) => {
  let proxyHits = 0;
  let proxyRequestUrl = '';
  const upstreamProxy = http.createServer((req, res) => {
    proxyHits++;
    proxyRequestUrl = req.url;
    res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
    res.end('through upstream proxy');
  });
  context.after(() => {
    app.config.settings.upstreamProxyRoutes = [];
    upstreamProxy.closeAllConnections();
    upstreamProxy.close();
  });
  await new Promise((resolve) => upstreamProxy.listen(0, '127.0.0.1', resolve));
  app.config.settings.upstreamProxyRoutes = [{ pattern: '127.0.0.1:*', url: `http://127.0.0.1:${upstreamProxy.address().port}` }];
  const response = await proxyRequest(`${originUrl}/through-proxy`);
  assert.equal(response.status, 200, response.body);
  assert.equal(response.body, 'through upstream proxy');
  assert.equal(proxyHits, 1);
  assert.match(proxyRequestUrl, /^http:\/\/127\.0\.0\.1:/);
});

test('negotiates HTTP/2 with direct HTTPS origins', async (context) => {
  const leaf = app.ca.leafFor('localhost');
  const h2Origin = http2.createSecureServer({ key: leaf.key, cert: leaf.cert, allowHTTP1: true });
  const sessions = new Set();
  h2Origin.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  context.after(() => {
    for (const session of sessions) session.destroy();
    h2Origin.close();
  });
  h2Origin.on('stream', (stream) => {
    stream.respond({ ':status': 200, 'content-type': 'text/plain' });
    stream.end('h2 body');
  });
  await new Promise((resolve) => h2Origin.listen(0, '127.0.0.1', resolve));
  const target = `https://localhost:${h2Origin.address().port}/h2`;
  const response = await proxyTlsRequest(target);
  assert.equal(response.status, 200, response.body);
  assert.equal(response.body, 'h2 body');
  const flow = app.store.flows.find((item) => item.request.url === target);
  assert.equal(flow.response.httpVersion, '2.0');
});

test('pauses at a breakpoint and applies manual edits', async () => {
  setRules([{
    name: 'breakpoint',
    enabled: true,
    match: { urlPattern: '/echo', matchType: 'contains' },
    actions: [{ type: 'breakpoint-request' }]
  }]);
  app.breakpoints.once('paused', ({ id }) => {
    app.breakpoints.resume(id, {
      method: 'POST',
      headers: [['host', new URL(originUrl).host], ['x-breakpoint', 'edited']],
      body: 'edited at breakpoint'
    });
  });
  const response = await proxyRequest(`${originUrl}/echo`);
  const payload = JSON.parse(response.body);
  assert.equal(payload.method, 'POST');
  assert.equal(payload.headers['x-breakpoint'], 'edited');
  assert.equal(payload.body, 'edited at breakpoint');
});

test('exposes flows, rules and settings over the local API', async () => {
  setRules([]);
  await proxyRequest(`${originUrl}/plain`);
  const state = await uiRequest('/api/state');
  assert.equal(state.status, 200);
  assert.ok(state.body.catalog.length > 0);

  const flows = await uiRequest('/api/flows');
  const target = flows.body.flows.find((f) => f.url.endsWith('/plain'));
  assert.ok(target);

  const detail = await uiRequest(`/api/flows/${target.id}`);
  assert.equal(detail.body.response.body, 'original body');

  const curl = await uiRequest(`/api/flows/${target.id}/curl`);
  assert.match(curl.body.command, /^curl -X GET/);

  const replayed = await uiRequest(`/api/flows/${target.id}/replay`, { method: 'POST', body: {} });
  assert.equal(replayed.body.status, 200);

  const har = await uiRequest('/api/flows/har');
  assert.ok(har.body.log.entries.length > 0);

  const created = await uiRequest('/api/rules', {
    method: 'POST',
    body: { rule: { name: 'api rule', match: { urlPattern: 'x' }, actions: [] } }
  });
  assert.equal(created.status, 201);
  const removed = await uiRequest(`/api/rules/${created.body.rule.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
});

test('searches captured headers, bodies and JSON paths', async () => {
  setRules([]);
  await proxyRequest(`${originUrl}/echo`, {
    method: 'POST',
    headers: { 'x-search-token': 'header-needle' },
    body: '{"user":{"id":"json-needle"}}'
  });
  const header = await uiRequest('/api/flows?q=header-needle');
  const body = await uiRequest('/api/flows?q=json-needle');
  const jsonPath = await uiRequest('/api/flows?q=request.%24.user.id%3Djson-needle');
  assert.ok(header.body.flows.some((flow) => flow.url.endsWith('/echo')));
  assert.ok(body.body.flows.some((flow) => flow.url.endsWith('/echo')));
  assert.ok(jsonPath.body.flows.some((flow) => flow.url.endsWith('/echo')));
});

test('supports bulk operations on flows and rules', async () => {
  setRules([]);
  await proxyRequest(`${originUrl}/bulk-a`);
  await proxyRequest(`${originUrl}/bulk-b`);
  const listed = (await uiRequest('/api/flows')).body.flows.filter((f) => f.url.includes('/bulk-'));
  assert.equal(listed.length, 2);

  const deleted = await uiRequest('/api/flows/delete', { method: 'POST', body: { ids: listed.map((f) => f.id) } });
  assert.equal(deleted.body.removed, 2);
  assert.equal((await uiRequest('/api/flows')).body.flows.filter((f) => f.url.includes('/bulk-')).length, 0);

  const a = await uiRequest('/api/rules', { method: 'POST', body: { rule: { name: 'bulk a', enabled: false } } });
  const b = await uiRequest('/api/rules', { method: 'POST', body: { rule: { name: 'bulk b', enabled: false } } });
  const ids = [a.body.rule.id, b.body.rule.id];

  await uiRequest('/api/rules/toggle', { method: 'POST', body: { ids, enabled: true } });
  let rules = (await uiRequest('/api/rules')).body.rules;
  assert.ok(ids.every((id) => rules.find((r) => r.id === id).enabled));

  const duplicated = await uiRequest('/api/rules/duplicate', { method: 'POST', body: { ids } });
  assert.equal(duplicated.body.created, 2);

  rules = (await uiRequest('/api/rules')).body.rules;
  const everything = rules.filter((r) => r.name.startsWith('bulk ')).map((r) => r.id);
  const removed = await uiRequest('/api/rules/delete', { method: 'POST', body: { ids: everything } });
  assert.equal(removed.body.removed, 4);
});

test('tests a rule against a sample URL', async () => {
  const wildcard = await uiRequest('/api/rules/test', {
    method: 'POST',
    body: { rule: { match: { urlPattern: '*/api/*', matchType: 'wildcard' } }, url: 'https://example.com/api/users' }
  });
  assert.equal(wildcard.body.matches, true);
  assert.deepEqual(wildcard.body.captures, ['https://example.com', 'users']);

  const miss = await uiRequest('/api/rules/test', {
    method: 'POST',
    body: { rule: { match: { urlPattern: '*/api/*', matchType: 'wildcard' } }, url: 'https://example.com/home' }
  });
  assert.equal(miss.body.matches, false);

  const broken = await uiRequest('/api/rules/test', {
    method: 'POST',
    body: { rule: { match: { urlPattern: '([', matchType: 'regex' } }, url: 'https://example.com' }
  });
  assert.equal(broken.body.matches, false);
  assert.match(broken.body.error, /Invalid regex/);
});

test('rejects non-local API callers', async () => {
  const server = app.api.server.address();
  assert.equal(server.address, '127.0.0.1');
});

test('tunnels TLS untouched when interception is disabled', async () => {
  app.config.settings.interceptHttps = false;
  const response = await new Promise((resolve, reject) => {
    const target = new URL(secureOriginUrl);
    const connectReq = http.request({
      host: '127.0.0.1',
      port: app.config.settings.proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port}`
    });
    connectReq.on('connect', (res, socket) => {
      const secured = tls.connect({ socket, servername: 'localhost', ca: [app.ca.caCertPem] }, () => {
        secured.write(`GET /plain HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
      });
      let data = '';
      secured.on('data', (chunk) => { data += chunk.toString(); });
      secured.on('end', () => resolve(data));
      secured.on('error', reject);
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
  app.config.settings.interceptHttps = true;
  assert.match(response, /original body/);
});
