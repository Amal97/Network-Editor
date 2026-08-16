'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detail, summarize } = require('./store');
const { makeRule, matchRule, ACTION_CATALOG } = require('./rules');
const { RESOURCE_TYPES, mimeForPath, getHeader } = require('./util');
const { trustCa, setSystemProxy, getSystemProxy, findBrowsers, launchBrowser } = require('./platform');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

class ApiServer {
  constructor({ config, ca, store, proxy, ruleEngine, breakpoints, scriptEngine }) {
    this.config = config;
    this.ca = ca;
    this.store = store;
    this.proxy = proxy;
    this.ruleEngine = ruleEngine;
    this.breakpoints = breakpoints;
    this.scriptEngine = scriptEngine;
    this.clients = new Set();
    this.queue = [];
    this.flushTimer = null;
    this.logs = [];
    this.systemProxyOwned = false;

    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => sendJson(res, 500, { error: err.message }));
    });

    store.on('flow', (event) => this.push(event.type === 'new' ? 'flow' : 'flow-update', event.flow));
    store.on('cleared', () => this.push('cleared', {}));
    store.on('removed', (ids) => this.push('flows-removed', ids));
    breakpoints.on('changed', () => this.push('breakpoints', this.breakpoints.list()));
    proxy.on('log', (entry) => this.log(entry));
  }

  log(entry) {
    const record = { time: Date.now(), ...entry };
    this.logs.push(record);
    if (this.logs.length > 500) this.logs.shift();
    this.push('log', record);
  }

  listen(port = this.config.settings.uiPort, host = this.config.settings.host) {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve(this.server.address());
      });
    });
  }

  close() {
    for (const client of this.clients) client.end();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  push(event, data) {
    this.queue.push({ event, data });
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const payload = this.queue;
      this.queue = [];
      const chunk = `event: batch\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const client of this.clients) {
        if (!client.writableEnded) client.write(chunk);
      }
    }, 60);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname;

    if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Forbidden: local access only' });
    if (mutating(req.method) && !sameOrigin(req)) {
      return sendJson(res, 403, { error: 'Forbidden: cross-origin request' });
    }

    if (route === '/api/events') return this.events(req, res);
    if (route.startsWith('/api/')) return this.api(req, res, route, url);
    return this.static(req, res, route);
  }

  events(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    if (ping.unref) ping.unref();
    req.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  async api(req, res, route, url) {
    const method = req.method;
    const segments = route.split('/').filter(Boolean); // ['api', ...]

    if (route === '/api/state' && method === 'GET') {
      return sendJson(res, 200, this.state());
    }

    if (route === '/api/flows' && method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      return sendJson(res, 200, { flows: this.store.list({ since }) });
    }
    if (route === '/api/flows' && method === 'DELETE') {
      this.store.clear();
      return sendJson(res, 200, { ok: true });
    }
    if (route === '/api/flows/delete' && method === 'POST') {
      const body = await readJson(req);
      const removed = this.store.remove(Array.isArray(body.ids) ? body.ids : []);
      return sendJson(res, 200, { removed: removed.length });
    }
    if (route === '/api/flows/har' && method === 'GET') {
      return sendJson(res, 200, buildHar(this.store.flows));
    }

    if (segments[1] === 'flows' && segments[2]) {
      const flow = this.store.get(segments[2]);
      if (!flow) return sendJson(res, 404, { error: 'Flow not found' });
      const action = segments[3];

      if (!action && method === 'GET') return sendJson(res, 200, detail(flow));
      if (action === 'curl' && method === 'GET') return sendJson(res, 200, { command: toCurl(flow) });
      if (action === 'resume' && method === 'POST') {
        const body = await readJson(req);
        const ok = this.breakpoints.resume(flow.id, body.patch || null);
        return sendJson(res, ok ? 200 : 409, { ok });
      }
      if (action === 'abort' && method === 'POST') {
        const body = await readJson(req);
        const ok = this.breakpoints.abort(flow.id, body.reason);
        return sendJson(res, ok ? 200 : 409, { ok });
      }
      if (action === 'replay' && method === 'POST') {
        const body = await readJson(req);
        const replayed = await this.proxy.replay(flow, body.overrides || {}, { applyRules: !!body.applyRules });
        return sendJson(res, 200, detail(replayed));
      }
      if (action === 'body' && method === 'GET') {
        const which = url.searchParams.get('side') === 'request' ? 'request' : 'response';
        const target = flow[which];
        if (!target || !target.body) return sendJson(res, 404, { error: 'No body' });
        res.writeHead(200, {
          'content-type': String(getHeader(target.headers, 'content-type') || 'application/octet-stream'),
          'content-disposition': `attachment; filename="${flow.id}-${which}"`
        });
        return res.end(target.body);
      }
    }

    if (route === '/api/breakpoints' && method === 'GET') {
      return sendJson(res, 200, { pending: this.breakpoints.list() });
    }
    if (route === '/api/breakpoints/resume-all' && method === 'POST') {
      this.breakpoints.resumeAll();
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/rules' && method === 'GET') {
      return sendJson(res, 200, { rules: this.config.rules });
    }
    if (route === '/api/rules' && method === 'POST') {
      const body = await readJson(req);
      const rule = makeRule(body.rule || body);
      this.config.rules.push(rule);
      this.persistRules();
      return sendJson(res, 201, { rule });
    }
    if (route === '/api/rules' && method === 'PUT') {
      const body = await readJson(req);
      if (!Array.isArray(body.rules)) return sendJson(res, 400, { error: 'rules array required' });
      this.config.rules = body.rules.map(makeRule);
      this.persistRules();
      return sendJson(res, 200, { rules: this.config.rules });
    }
    if (route === '/api/rules/delete' && method === 'POST') {
      const body = await readJson(req);
      const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
      const before = this.config.rules.length;
      this.config.rules = this.config.rules.filter((rule) => !ids.has(rule.id));
      this.persistRules();
      return sendJson(res, 200, { removed: before - this.config.rules.length });
    }
    if (route === '/api/rules/toggle' && method === 'POST') {
      const body = await readJson(req);
      const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
      for (const rule of this.config.rules) {
        if (ids.has(rule.id)) rule.enabled = !!body.enabled;
      }
      this.persistRules();
      return sendJson(res, 200, { rules: this.config.rules });
    }
    if (route === '/api/rules/duplicate' && method === 'POST') {
      const body = await readJson(req);
      const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
      const copies = this.config.rules
        .filter((rule) => ids.has(rule.id))
        .map((rule) => makeRule({ ...JSON.parse(JSON.stringify(rule)), id: undefined, name: `${rule.name} (copy)` }));
      this.config.rules.push(...copies);
      this.persistRules();
      return sendJson(res, 200, { rules: this.config.rules, created: copies.length });
    }
    if (route === '/api/rules/test' && method === 'POST') {
      const body = await readJson(req);
      const rule = makeRule(body.rule || {});
      const probe = {
        id: 'probe',
        resourceType: body.resourceType || 'other',
        request: { method: String(body.method || 'GET').toUpperCase(), url: String(body.url || ''), headers: [] },
        response: { statusCode: Number(body.status) || 200, headers: [] }
      };
      try {
        const requestMatch = matchRule(rule, probe, 'request');
        const responseMatch = matchRule(rule, probe, 'response');
        return sendJson(res, 200, {
          matches: !!requestMatch || !!responseMatch,
          captures: requestMatch || responseMatch || []
        });
      } catch (err) {
        return sendJson(res, 200, { matches: false, error: err.message });
      }
    }
    if (segments[1] === 'rules' && segments[2] && method === 'PUT') {
      const body = await readJson(req);
      const index = this.config.rules.findIndex((r) => r.id === segments[2]);
      if (index === -1) return sendJson(res, 404, { error: 'Rule not found' });
      this.config.rules[index] = makeRule({ ...body.rule || body, id: segments[2] });
      this.persistRules();
      return sendJson(res, 200, { rule: this.config.rules[index] });
    }
    if (segments[1] === 'rules' && segments[2] && method === 'DELETE') {
      this.config.rules = this.config.rules.filter((r) => r.id !== segments[2]);
      this.persistRules();
      return sendJson(res, 200, { ok: true });
    }
    if (route === '/api/script/validate' && method === 'POST') {
      const body = await readJson(req);
      const error = this.scriptEngine.check(String(body.code || ''));
      return sendJson(res, 200, { ok: !error, error });
    }

    if (route === '/api/settings' && method === 'GET') {
      return sendJson(res, 200, { settings: this.config.settings });
    }
    if (route === '/api/settings' && (method === 'PUT' || method === 'PATCH')) {
      const body = await readJson(req);
      const settings = this.config.updateSettings(body.settings || body);
      this.store.setMax(settings.maxFlows);
      this.push('settings', settings);
      return sendJson(res, 200, { settings });
    }

    if (route === '/api/ca' && method === 'GET') {
      return sendJson(res, 200, { ca: this.ca.info(), instructions: caInstructions(this.ca) });
    }
    if (route === '/api/ca.crt' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'application/x-x509-ca-cert',
        'content-disposition': 'attachment; filename="network-modifier-ca.crt"'
      });
      return res.end(this.ca.caCertPem);
    }
    if (route === '/api/ca/regenerate' && method === 'POST') {
      this.ca.generateRoot();
      return sendJson(res, 200, { ca: this.ca.info() });
    }

    if (route === '/api/logs' && method === 'GET') return sendJson(res, 200, { logs: this.logs });

    if (route === '/api/system' && method === 'GET') {
      return sendJson(res, 200, {
        platform: os.platform(),
        systemProxy: await getSystemProxy(),
        browsers: findBrowsers().map(({ id, name }) => ({ id, name })),
        managedByUs: !!this.systemProxyOwned
      });
    }
    if (route === '/api/system/trust' && method === 'POST') {
      const body = await readJson(req);
      const result = await trustCa(this.ca.caCertPath, { systemWide: !!body.systemWide });
      return sendJson(res, result.ok ? 200 : 500, {
        ok: result.ok,
        error: result.ok ? null : (result.stderr || '').trim() || 'Could not install the certificate',
        hint: result.hint || ''
      });
    }
    if (route === '/api/system/proxy' && method === 'POST') {
      const body = await readJson(req);
      const enabled = !!body.enabled;
      const address = this.proxy.server.address();
      const result = await setSystemProxy(enabled, this.config.settings.host, address ? address.port : this.config.settings.proxyPort);
      if (result.ok) this.systemProxyOwned = enabled;
      return sendJson(res, result.ok ? 200 : 500, {
        ok: result.ok,
        systemProxy: await getSystemProxy(),
        error: result.ok ? null : (result.stderr || '').trim() || 'Could not change the system proxy',
        hint: result.hint || ''
      });
    }
    if (route === '/api/system/browser' && method === 'POST') {
      const body = await readJson(req);
      const address = this.proxy.server.address();
      const result = launchBrowser(String(body.id || ''), {
        host: this.config.settings.host,
        port: address ? address.port : this.config.settings.proxyPort,
        url: typeof body.url === 'string' && /^https?:\/\//i.test(body.url) ? body.url : 'about:blank'
      });
      return sendJson(res, result.ok ? 200 : 500, result);
    }

    return sendJson(res, 404, { error: `Unknown endpoint ${method} ${route}` });
  }

  persistRules() {
    this.config.save();
    this.ruleEngine.setRules(this.config.rules);
    this.push('rules', this.config.rules);
  }

  state() {
    const address = this.proxy.server.address();
    return {
      settings: this.config.settings,
      proxy: {
        host: address ? address.address : this.config.settings.host,
        port: address ? address.port : this.config.settings.proxyPort,
        running: !!address
      },
      ui: { port: this.config.settings.uiPort },
      ca: this.ca.info(),
      rules: this.config.rules,
      breakpoints: this.breakpoints.list(),
      catalog: ACTION_CATALOG,
      resourceTypes: RESOURCE_TYPES,
      instructions: caInstructions(this.ca),
      version: require('../package.json').version
    };
  }

  static(req, res, route) {
    const relative = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
    const filePath = path.join(PUBLIC_DIR, relative);
    if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'content-type': mimeForPath(filePath),
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
      });
      res.end(data);
    });
  }
}

/* ------------------------------------------------------------------ helpers */

function isLocalRequest(req) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function mutating(method) {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function sendJson(res, status, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store'
  });
  res.end(data);
}

function readJson(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function caInstructions(ca) {
  return {
    certPath: ca.caCertPath,
    macos: [
      'Automatic: run  netmod trust  (asks for your password once).',
      `Manual: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${ca.caCertPath}"`,
      'Firefox uses its own store: Settings > Privacy & Security > Certificates > View Certificates > Authorities > Import.'
    ],
    windows: [
      'Automatic: run  netmod trust  (installs into the current user Root store).',
      `Manual: certutil -addstore -user Root "${ca.caCertPath}"`,
      'Or double-click the .crt file > Install Certificate > Current User > Place all certificates in "Trusted Root Certification Authorities".'
    ],
    linux: [
      `sudo cp "${ca.caCertPath}" /usr/local/share/ca-certificates/network-modifier.crt && sudo update-ca-certificates`
    ]
  };
}

function toCurl(flow) {
  const parts = [`curl -X ${flow.request.method} ${shellQuote(flow.request.url)}`];
  for (const [name, value] of flow.request.headers) {
    if (name.toLowerCase() === 'content-length') continue;
    parts.push(`  -H ${shellQuote(`${name}: ${value}`)}`);
  }
  if (flow.request.body && flow.request.body.length) {
    parts.push(`  --data-binary ${shellQuote(flow.request.body.toString('utf8'))}`);
  }
  return parts.join(' \\\n');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildHar(flows) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Network Modifier', version: require('../package.json').version },
      entries: flows.filter((f) => f.response).map((flow) => {
        const summary = summarize(flow);
        let queryString = [];
        try {
          queryString = [...new URL(flow.request.url).searchParams].map(([name, value]) => ({ name, value }));
        } catch { /* ignore */ }
        return {
          startedDateTime: new Date(flow.startTime).toISOString(),
          time: summary.duration || 0,
          request: {
            method: flow.request.method,
            url: flow.request.url,
            httpVersion: `HTTP/${flow.request.httpVersion || '1.1'}`,
            headers: flow.request.headers.map(([name, value]) => ({ name, value })),
            queryString,
            cookies: [],
            headersSize: -1,
            bodySize: flow.request.body ? flow.request.body.length : 0,
            postData: flow.request.body && flow.request.body.length ? {
              mimeType: String(getHeader(flow.request.headers, 'content-type') || 'application/octet-stream'),
              text: flow.request.body.toString('utf8')
            } : undefined
          },
          response: {
            status: flow.response.statusCode,
            statusText: flow.response.statusMessage || '',
            httpVersion: `HTTP/${flow.response.httpVersion || '1.1'}`,
            headers: flow.response.headers.map(([name, value]) => ({ name, value })),
            cookies: [],
            content: {
              size: flow.response.body ? flow.response.body.length : 0,
              mimeType: String(getHeader(flow.response.headers, 'content-type') || ''),
              text: flow.response.body ? flow.response.body.toString('base64') : '',
              encoding: 'base64'
            },
            redirectURL: String(getHeader(flow.response.headers, 'location') || ''),
            headersSize: -1,
            bodySize: flow.response.body ? flow.response.body.length : 0
          },
          cache: {},
          timings: { send: 0, wait: summary.duration || 0, receive: 0 }
        };
      })
    }
  };
}

module.exports = { ApiServer };
