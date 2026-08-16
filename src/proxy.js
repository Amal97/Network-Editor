'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const http2wrapper = require('http2-wrapper');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const {
  collectBody, detectResourceType, rawToPairs, getHeader, setHeader, removeHeader,
  nextId, wildcardToRegExp
} = require('./util');

const HOP_BY_HOP = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

const MAIL_PORTS = new Set([25, 110, 143, 465, 587, 993, 995]);
const MAIL_HOST_PREFIXES = ['autodiscover.', 'imap.', 'mail.', 'pop.', 'pop3.', 'smtp.'];
const MAIL_SERVICE_DOMAINS = [
  'gmail.com', 'googlemail.com', 'accounts.google.com',
  'outlook.com', 'office.com', 'office365.com', 'microsoftonline.com',
  'live.com', 'msauth.net', 'msftauth.net', 'msidentity.com',
  'icloud.com', 'me.com'
];

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128 });

class ProxyServer extends EventEmitter {
  constructor({ config, ca, store, ruleEngine, breakpoints }) {
    super();
    this.config = config;
    this.ca = ca;
    this.store = store;
    this.rules = ruleEngine;
    this.breakpoints = breakpoints;

    this.server = http.createServer();
    this.server.on('request', (req, res) => this.onRequest(req, res, 'http'));
    this.server.on('connect', (req, socket, head) => this.onConnect(req, socket, head));
    this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head, 'http'));
    this.server.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    // Not listening: used purely as an HTTP parser for decrypted TLS sockets.
    this.tlsHandler = http.createServer();
    this.tlsHandler.on('request', (req, res) => this.onRequest(req, res, 'https'));
    this.tlsHandler.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head, 'https'));
    this.tlsHandler.on('clientError', (err, socket) => socket.destroy());

    this.tunnels = 0;
    // http.Server stops tracking sockets once CONNECT/upgrade detaches them.
    this.detachedSockets = new Set();
    this.webSocketServer = new WebSocketServer({ noServer: true });
    this.webSockets = new Map();
    this.proxyAgents = new Map();
  }

  track(socket) {
    this.detachedSockets.add(socket);
    socket.once('close', () => this.detachedSockets.delete(socket));
  }

  get settings() {
    return this.config.settings;
  }

  listen(port = this.settings.proxyPort, host = this.settings.host) {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve(this.server.address());
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      this.breakpoints.abortAll('Proxy shutting down');
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
      for (const socket of this.detachedSockets) socket.destroy();
      for (const pair of this.webSockets.values()) {
        pair.client.terminate();
        pair.upstream.terminate();
      }
      this.webSockets.clear();
      this.detachedSockets.clear();
      httpAgent.destroy();
      httpsAgent.destroy();
    });
  }

  /* ------------------------------------------------------------------ CONNECT */

  onConnect(req, socket, head) {
    const [host, portText] = splitHostPort(req.url, 443);
    const port = Number(portText);
    this.track(socket);
    socket.on('error', () => socket.destroy());

    if (!this.settings.interceptHttps ||
        this.isBypassed(`${host}:${port}`) ||
        (this.settings.protectEmailTraffic && isLikelyEmailTraffic(host, port))) {
      return this.tunnel(socket, head, host, port);
    }

    socket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: network-modifier\r\n\r\n');
    if (head && head.length) socket.unshift(head);

    peek(socket, (err, first) => {
      if (err || !first) return socket.destroy();
      if (first[0] !== 0x16) {
        // Plain HTTP inside the tunnel (rare, but some clients do it).
        socket._netmodConnect = { host, port, tls: false };
        this.server.emit('connection', socket);
        return;
      }
      let tlsSocket;
      try {
        tlsSocket = new tls.TLSSocket(socket, {
          isServer: true,
          // Only HTTP/1.1 is parsed, so never let a browser negotiate h2 over this socket.
          ALPNProtocols: ['http/1.1'],
          secureContext: this.ca.secureContextFor(host),
          SNICallback: (servername, cb) => {
            try {
              cb(null, this.ca.secureContextFor(servername || host));
            } catch (e) {
              cb(e);
            }
          }
        });
      } catch (e) {
        this.emit('log', { level: 'error', message: `TLS setup failed for ${host}: ${e.message}` });
        return socket.destroy();
      }
      tlsSocket._netmodConnect = { host, port, tls: true };
      this.track(tlsSocket);
      tlsSocket.on('error', () => tlsSocket.destroy());
      this.tlsHandler.emit('connection', tlsSocket);
    });
  }

  tunnel(clientSocket, head, host, port) {
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: network-modifier\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    this.track(upstream);
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => upstream.destroy());
  }

  isBypassed(hostPort) {
    const list = this.settings.bypassHosts || [];
    return list.some((pattern) => {
      if (!pattern) return false;
      const p = pattern.includes(':') ? pattern : `${pattern}:*`;
      return wildcardToRegExp(p, 'i').test(hostPort);
    });
  }

  /* ---------------------------------------------------------------- WebSocket */

  onUpgrade(req, socket, head, scheme) {
    const target = this.absoluteUrl(req, scheme);
    const flow = this.createFlow(req, target, scheme, 'websocket');
    flow.state = 'websocket';
    flow.webSocketFrames = [];
    if (this.shouldCapture(flow)) this.store.add(flow);
    const wsUrl = target.replace(/^http/i, 'ws');
    const headers = Object.fromEntries(req.headers ? Object.entries(req.headers).filter(([name]) =>
      !['connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'host'].includes(name.toLowerCase())) : []);
    const proxyUrl = this.resolveUpstreamProxy(new URL(target));
    const upstream = new WebSocket(wsUrl, req.headers['sec-websocket-protocol'] || undefined, {
      headers,
      rejectUnauthorized: this.settings.rejectUnauthorized,
      agent: proxyUrl ? this.proxyAgent(proxyUrl, target.startsWith('https:')) : undefined
    });

    upstream.once('open', () => {
      this.webSocketServer.handleUpgrade(req, socket, head, (client) => {
        this.webSockets.set(flow.id, { client, upstream });
        const relay = (source, destination, direction) => source.on('message', (data, isBinary) => {
          this.recordWebSocketFrame(flow, direction, data, isBinary);
          if (destination.readyState === WebSocket.OPEN) destination.send(data, { binary: isBinary });
        });
        relay(client, upstream, 'client-to-server');
        relay(upstream, client, 'server-to-client');
        const close = () => {
          client.terminate();
          upstream.terminate();
          this.webSockets.delete(flow.id);
          flow.endTime = Date.now();
          flow.state = flow.error ? 'error' : 'completed';
          this.store.touch(flow);
        };
        client.once('close', close);
        upstream.once('close', close);
        client.on('error', (err) => { flow.error = err.message; });
        upstream.on('error', (err) => { flow.error = err.message; });
      });
    });
    upstream.once('error', (err) => {
      flow.error = err.message;
      flow.state = 'error';
      flow.endTime = Date.now();
      if (this.store.get(flow.id)) this.store.touch(flow);
      socket.destroy();
    });
  }

  recordWebSocketFrame(flow, direction, data, isBinary) {
    const buffer = Buffer.from(data);
    flow.webSocketFrames.push({
      id: nextId('ws'), direction, time: Date.now(), binary: isBinary,
      data: isBinary ? buffer.toString('base64') : buffer.toString('utf8'), size: buffer.length
    });
    if (flow.webSocketFrames.length > 1000) flow.webSocketFrames.shift();
    this.store.touch(flow);
  }

  sendWebSocketFrame(flowId, { direction, data, binary }) {
    const pair = this.webSockets.get(flowId);
    if (!pair) return false;
    const destination = direction === 'server-to-client' ? pair.client : pair.upstream;
    if (destination.readyState !== WebSocket.OPEN) return false;
    const payload = binary ? Buffer.from(String(data || ''), 'base64') : String(data || '');
    destination.send(payload, { binary: !!binary });
    const flow = this.store.get(flowId);
    if (flow) this.recordWebSocketFrame(flow, `${direction}-edited`, payload, !!binary);
    return true;
  }

  /* ------------------------------------------------------------------ Request */

  absoluteUrl(req, scheme) {
    if (/^https?:\/\//i.test(req.url)) return req.url;
    const connectInfo = req.socket._netmodConnect || (req.socket._parent && req.socket._parent._netmodConnect);
    const hostHeader = req.headers.host || (connectInfo ? `${connectInfo.host}:${connectInfo.port}` : 'unknown');
    const proto = connectInfo && connectInfo.tls === false ? 'http' : scheme;
    return `${proto}://${hostHeader}${req.url}`;
  }

  createFlow(req, url, scheme, forcedType) {
    const headers = rawToPairs(req.rawHeaders);
    return {
      id: nextId(),
      startTime: Date.now(),
      endTime: null,
      state: 'pending',
      scheme,
      clientIp: req.socket.remoteAddress,
      clientSource: detectClientSource(req.headers),
      resourceType: forcedType || detectResourceType(req.method, url, req.headers),
      modified: { request: false, response: false },
      rulesApplied: [],
      errors: [],
      timing: { start: Date.now() },
      request: {
        method: req.method,
        url,
        httpVersion: req.httpVersion,
        headers,
        body: null,
        truncated: false,
        stream: null,
        size: 0
      },
      response: null
    };
  }

  shouldCapture(flow) {
    if (!this.settings.recording) return false;
    const filter = this.settings.captureFilter || {};
    const hasFilter = filter.urlPattern || (filter.methods || []).length || (filter.resourceTypes || []).length;
    if (!hasFilter) return true;
    let ok = true;
    if (filter.urlPattern) {
      const flags = filter.caseSensitive ? '' : 'i';
      if (filter.matchType === 'regex') {
        try {
          ok = new RegExp(filter.urlPattern, flags).test(flow.request.url);
        } catch { ok = true; }
      } else if (filter.matchType === 'wildcard') {
        ok = wildcardToRegExp(filter.urlPattern, flags).test(flow.request.url);
      } else {
        ok = flow.request.url.toLowerCase().includes(String(filter.urlPattern).toLowerCase());
      }
    }
    if (ok && (filter.methods || []).length) {
      ok = filter.methods.map((m) => m.toUpperCase()).includes(flow.request.method.toUpperCase());
    }
    if (ok && (filter.resourceTypes || []).length) {
      ok = filter.resourceTypes.includes(flow.resourceType);
    }
    return filter.negate ? !ok : ok;
  }

  async onRequest(req, res, scheme) {
    const url = this.absoluteUrl(req, scheme);
    const flow = this.createFlow(req, url, scheme);
    const captured = this.shouldCapture(flow);
    if (captured) this.store.add(flow);

    req.on('aborted', () => {
      if (flow.state === 'pending') {
        flow.state = 'aborted';
        flow.endTime = Date.now();
        if (captured) this.store.touch(flow);
      }
    });

    try {
      const collected = await collectBody(req, this.settings.maxBodySize);
      flow.request.body = collected.body;
      flow.request.truncated = collected.truncated;
      flow.request.stream = collected.stream;
      flow.request.size = collected.size;
      flow.timing.requestReceived = Date.now();
      flow.originalRequest = snapshotMessage(flow.request);

      let directives = { cancel: false, breakpoint: false, delayMs: 0, mock: null, throttle: 0, applied: [], errors: [] };
      if (captured) {
        directives = this.rules.apply(flow, 'request');
        recordRules(flow, directives);
      }

      if (directives.breakpoint || this.breakpointMatches(flow, 'request')) {
        const outcome = await this.pause(flow, 'request');
        if (outcome.action === 'abort') return this.cancelRequest(flow, res, outcome.reason, captured);
        if (outcome.patch) applyRequestPatch(flow, outcome.patch);
        if (outcome.mock) directives.mock = outcome.mock;
      }

      if (directives.cancel) return this.cancelRequest(flow, res, directives.cancelReason, captured);
      if (directives.delayMs > 0) await sleep(directives.delayMs);

      if (directives.mock) {
        flow.response = {
          statusCode: directives.mock.statusCode,
          statusMessage: directives.mock.statusMessage || http.STATUS_CODES[directives.mock.statusCode] || '',
          httpVersion: '1.1',
          headers: directives.mock.headers.map(([k, v]) => [k, String(v)]),
          body: directives.mock.body,
          truncated: false,
          stream: null
        };
        flow.mocked = true;
        flow.modified.response = true;
        return this.finishResponse(flow, res, captured, directives.throttle);
      }

      await this.forward(flow, res, captured, directives.throttle);
    } catch (err) {
      this.fail(flow, res, err, captured);
    }
  }

  breakpointMatches(flow, phase) {
    const bp = this.settings.breakpoints || {};
    if (!this.settings.breakpointsEnabled) return false;
    if (phase === 'request' && !bp.onRequest) return false;
    if (phase === 'response' && !bp.onResponse) return false;
    if (bp.urlPattern) {
      return flow.request.url.toLowerCase().includes(String(bp.urlPattern).toLowerCase());
    }
    return true;
  }

  async pause(flow, phase) {
    flow.state = `paused-${phase}`;
    this.store.touch(flow);
    const outcome = await this.breakpoints.pause(flow, phase);
    flow.state = phase === 'request' ? 'pending' : 'responding';
    this.store.touch(flow);
    return outcome;
  }

  cancelRequest(flow, res, reason, captured) {
    flow.state = 'cancelled';
    flow.error = reason || 'Cancelled';
    flow.endTime = Date.now();
    if (captured) this.store.touch(flow);
    if (res && !res.headersSent) res.socket && res.socket.destroy();
    else if (res) res.destroy();
  }

  fail(flow, res, err, captured) {
    flow.state = 'error';
    flow.error = err.message;
    flow.endTime = Date.now();
    if (captured) this.store.touch(flow);
    this.emit('log', { level: 'error', message: `${flow.request.method} ${flow.request.url} -> ${err.message}` });
    if (res && !res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Network Modifier: upstream request failed\n${err.message}\n`);
    } else if (res) {
      res.destroy();
    }
  }

  buildUpstreamOptions(flow) {
    const target = new URL(flow.request.url);
    const isTls = target.protocol === 'https:';
    const headers = [];
    for (const [name, value] of flow.request.headers) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue;
      headers.push(name, value);
    }
    const proxyUrl = this.resolveUpstreamProxy(target);
    const parsedProxy = proxyUrl ? new URL(proxyUrl) : null;
    const directHttpProxy = parsedProxy && !isTls && /^https?:$/.test(parsedProxy.protocol);
    if (directHttpProxy && (parsedProxy.username || parsedProxy.password)) {
      const credentials = `${decodeURIComponent(parsedProxy.username)}:${decodeURIComponent(parsedProxy.password)}`;
      headers.push('proxy-authorization', `Basic ${Buffer.from(credentials).toString('base64')}`);
    }
    return {
      isTls,
      useHttp2: isTls && !proxyUrl && this.settings.enableHttp2Upstream,
      options: {
        protocol: directHttpProxy ? parsedProxy.protocol : target.protocol,
        host: directHttpProxy ? parsedProxy.hostname : target.hostname,
        port: directHttpProxy ? (parsedProxy.port || (parsedProxy.protocol === 'https:' ? 443 : 80)) : (target.port || (isTls ? 443 : 80)),
        method: flow.request.method,
        path: directHttpProxy ? target.toString() : target.pathname + target.search,
        headers: proxyUrl && !directHttpProxy ? pairsToHeaderObject(headers) : headers,
        setHost: false,
        agent: proxyUrl && !directHttpProxy ? this.proxyAgent(proxyUrl, isTls) : (directHttpProxy && parsedProxy.protocol === 'https:' ? httpsAgent : (isTls ? httpsAgent : httpAgent)),
        rejectUnauthorized: this.settings.rejectUnauthorized,
        servername: target.hostname
      }
    };
  }

  resolveUpstreamProxy(target) {
    for (const route of this.settings.upstreamProxyRoutes || []) {
      if (route && route.pattern && route.url && wildcardToRegExp(route.pattern, 'i').test(target.host)) return route.url;
    }
    return this.settings.upstreamProxy || '';
  }

  proxyAgent(proxyUrl, isTls) {
    const key = `${isTls}:${proxyUrl}`;
    if (this.proxyAgents.has(key)) return this.proxyAgents.get(key);
    const protocol = new URL(proxyUrl).protocol;
    const agent = protocol.startsWith('socks')
      ? new SocksProxyAgent(proxyUrl)
      : isTls ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl);
    this.proxyAgents.set(key, agent);
    return agent;
  }

  async forward(flow, res, captured, throttle) {
    return new Promise((resolve) => {
      const { isTls, useHttp2, options } = this.buildUpstreamOptions(flow);
      const transport = isTls ? https : http;
      flow.timing.upstreamStart = Date.now();
      const onResponse = async (upstreamRes) => {
        flow.timing.firstByte = Date.now();
        try {
          await this.handleUpstreamResponse(flow, upstreamRes, res, captured, throttle);
        } catch (err) {
          this.fail(flow, res, err, captured);
        }
        resolve();
      };
      const requestOptions = useHttp2
        ? {
            ...options,
            headers: pairsToHeaderObject(options.headers),
            agent: { http: httpAgent, https: httpsAgent, http2: http2wrapper.globalAgent }
          }
        : options;
      const start = useHttp2 ? http2wrapper.auto(requestOptions, onResponse) : Promise.resolve(transport.request(requestOptions, onResponse));
      start.then((upstreamReq) => {
        upstreamReq.on('error', (err) => {
          this.fail(flow, res, err, captured);
          resolve();
        });
        if (flow.request.truncated && flow.request.stream) flow.request.stream.pipe(upstreamReq);
        else {
          if (flow.request.body && flow.request.body.length) upstreamReq.write(flow.request.body);
          upstreamReq.end();
        }
      }).catch((err) => {
        this.fail(flow, res, err, captured);
        resolve();
      });
    });
  }

  async handleUpstreamResponse(flow, upstreamRes, res, captured, throttle) {
    const headers = rawToPairs(upstreamRes.rawHeaders).filter(([name]) => !name.startsWith(':'));
    flow.response = {
      statusCode: upstreamRes.statusCode,
      statusMessage: upstreamRes.statusMessage,
      httpVersion: upstreamRes.httpVersion,
      headers,
      body: null,
      truncated: false,
      stream: null,
      size: 0
    };
    flow.state = 'responding';
    if (captured) this.store.touch(flow);

    const encoding = String(getHeader(headers, 'content-encoding') || '').toLowerCase();
    const source = this.settings.decodeContentEncoding ? decodeStream(upstreamRes, encoding) : upstreamRes;
    if (source !== upstreamRes) {
      removeHeader(flow.response.headers, 'content-encoding');
      source.on('error', (err) => {
        flow.errors.push(`decode: ${err.message}`);
      });
    }

    const collected = await collectBody(source, this.settings.maxBodySize);
    flow.response.body = collected.body;
    flow.response.truncated = collected.truncated;
    flow.response.stream = collected.stream;
    flow.response.size = collected.size;
    flow.timing.responseReceived = Date.now();
    flow.originalResponse = snapshotMessage(flow.response);

    let directives = { cancel: false, breakpoint: false, delayMs: 0, throttle: 0, applied: [], errors: [] };
    if (captured && !flow.response.truncated) {
      directives = this.rules.apply(flow, 'response');
      recordRules(flow, directives);
    }

    if (directives.breakpoint || this.breakpointMatches(flow, 'response')) {
      const outcome = await this.pause(flow, 'response');
      if (outcome.action === 'abort') return this.cancelRequest(flow, res, outcome.reason, captured);
      if (outcome.patch) applyResponsePatch(flow, outcome.patch);
    }

    if (directives.cancel) return this.cancelRequest(flow, res, directives.cancelReason, captured);
    if (directives.delayMs > 0) await sleep(directives.delayMs);

    await this.finishResponse(flow, res, captured, directives.throttle || throttle);
  }

  async finishResponse(flow, res, captured, throttle) {
    const response = flow.response;
    const headers = response.headers.filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase()));

    if (!response.truncated) {
      const length = response.body ? response.body.length : 0;
      setHeader(headers, 'content-length', String(length));
    }

    if (res.destroyed || res.writableEnded) {
      flow.state = 'aborted';
      flow.endTime = Date.now();
      if (captured) this.store.touch(flow);
      return;
    }

    res.writeHead(
      response.statusCode,
      response.statusMessage || http.STATUS_CODES[response.statusCode] || '',
      headers.flat()
    );

    if (response.truncated && response.stream) {
      await pipeStream(response.stream, res);
    } else if (response.body && response.body.length) {
      await writeBody(res, response.body, throttle);
    } else {
      res.end();
    }

    flow.state = 'completed';
    flow.endTime = Date.now();
    flow.timing.end = flow.endTime;
    if (captured) this.store.touch(flow);
  }

  /** Re-sends a captured request (optionally edited) without a downstream client. */
  async replay(sourceFlow, overrides = {}, { applyRules = false } = {}) {
    const flow = {
      id: nextId(),
      startTime: Date.now(),
      endTime: null,
      state: 'pending',
      scheme: sourceFlow.scheme,
      clientIp: 'replay',
      resourceType: sourceFlow.resourceType,
      modified: { request: true, response: false },
      rulesApplied: [],
      errors: [],
      replayOf: sourceFlow.id,
      timing: { start: Date.now() },
      request: {
        method: overrides.method || sourceFlow.request.method,
        url: overrides.url || sourceFlow.request.url,
        httpVersion: '1.1',
        headers: overrides.headers
          ? overrides.headers.map(([k, v]) => [k, String(v)])
          : sourceFlow.request.headers.map((pair) => [...pair]),
        body: decodePatchBody(overrides, sourceFlow.request.body),
        truncated: false,
        stream: null,
        size: 0
      },
      response: null
    };
    if (flow.request.body) setHeader(flow.request.headers, 'content-length', String(flow.request.body.length));
    this.store.add(flow);

    if (applyRules) recordRules(flow, this.rules.apply(flow, 'request'));

    const { isTls, options } = this.buildUpstreamOptions(flow);
    const transport = isTls ? https : http;

    return new Promise((resolve) => {
      const req = transport.request(options, async (upstreamRes) => {
        const headers = rawToPairs(upstreamRes.rawHeaders);
        const encoding = String(getHeader(headers, 'content-encoding') || '').toLowerCase();
        const source = this.settings.decodeContentEncoding ? decodeStream(upstreamRes, encoding) : upstreamRes;
        const collected = await collectBody(source, this.settings.maxBodySize);
        flow.response = {
          statusCode: upstreamRes.statusCode,
          statusMessage: upstreamRes.statusMessage,
          httpVersion: upstreamRes.httpVersion,
          headers: source === upstreamRes ? headers : removeHeader(headers, 'content-encoding'),
          body: collected.body,
          truncated: collected.truncated,
          stream: null,
          size: collected.size
        };
        if (applyRules) recordRules(flow, this.rules.apply(flow, 'response'));
        flow.state = 'completed';
        flow.endTime = Date.now();
        this.store.touch(flow);
        resolve(flow);
      });
      req.on('error', (err) => {
        flow.state = 'error';
        flow.error = err.message;
        flow.endTime = Date.now();
        this.store.touch(flow);
        resolve(flow);
      });
      if (flow.request.body && flow.request.body.length) req.write(flow.request.body);
      req.end();
    });
  }
}

/* ------------------------------------------------------------------ helpers */

function recordRules(flow, directives) {
  for (const rule of directives.applied || []) {
    if (!flow.rulesApplied.some((r) => r.id === rule.id && r.phase === rule.phase)) {
      flow.rulesApplied.push(rule);
    }
  }
  for (const err of directives.errors || []) flow.errors.push(err);
}

function splitHostPort(value, fallbackPort) {
  const match = /^\[?([^\]]+)\]?:(\d+)$/.exec(value) || /^\[?([^\]]+)\]?$/.exec(value);
  return [match ? match[1] : value, match && match[2] ? match[2] : String(fallbackPort)];
}

function peek(socket, cb) {
  const onReadable = () => {
    const chunk = socket.read();
    if (chunk === null) return;
    socket.removeListener('readable', onReadable);
    socket.removeListener('error', onError);
    socket.removeListener('end', onEnd);
    socket.unshift(chunk);
    cb(null, chunk);
  };
  const onError = (err) => {
    socket.removeListener('readable', onReadable);
    cb(err);
  };
  const onEnd = () => cb(null, null);
  socket.on('readable', onReadable);
  socket.once('error', onError);
  socket.once('end', onEnd);
  onReadable();
}

function decodeStream(stream, encoding) {
  const opts = { finishFlush: zlib.constants.Z_SYNC_FLUSH, flush: zlib.constants.Z_SYNC_FLUSH };
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return stream.pipe(zlib.createGunzip(opts));
    case 'deflate':
      return stream.pipe(zlib.createInflate(opts));
    case 'br':
      return stream.pipe(zlib.createBrotliDecompress());
    case 'zstd':
      return typeof zlib.createZstdDecompress === 'function'
        ? stream.pipe(zlib.createZstdDecompress())
        : stream;
    default:
      return stream;
  }
}

function rebuildUpgradeRequest(req, parsed) {
  const lines = [`${req.method} ${parsed.pathname}${parsed.search} HTTP/1.1`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  }
  return lines.join('\r\n') + '\r\n\r\n';
}

function snapshotMessage(message) {
  return {
    ...message,
    headers: message.headers.map(([name, value]) => [name, value]),
    body: message.body ? Buffer.from(message.body) : message.body,
    stream: null
  };
}

function pairsToHeaderObject(flatHeaders) {
  const headers = {};
  for (let index = 0; index < flatHeaders.length; index += 2) {
    const name = flatHeaders[index];
    const value = flatHeaders[index + 1];
    if (headers[name] === undefined) headers[name] = value;
    else headers[name] = [].concat(headers[name], value);
  }
  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pipeStream(source, destination) {
  return new Promise((resolve) => {
    source.pipe(destination);
    destination.on('finish', resolve);
    destination.on('close', resolve);
    source.on('error', () => {
      destination.destroy();
      resolve();
    });
  });
}

async function writeBody(res, buffer, bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) {
    res.end(buffer);
    return;
  }
  const chunkSize = Math.max(1024, Math.floor(bytesPerSecond / 10));
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    if (res.destroyed) return;
    res.write(buffer.subarray(offset, offset + chunkSize));
    await sleep((chunkSize / bytesPerSecond) * 1000);
  }
  res.end();
}

function decodePatchBody(patch, fallback) {
  if (patch.body === undefined || patch.body === null) return fallback;
  if (Buffer.isBuffer(patch.body)) return patch.body;
  return patch.bodyEncoding === 'base64'
    ? Buffer.from(String(patch.body), 'base64')
    : Buffer.from(String(patch.body), 'utf8');
}

function applyRequestPatch(flow, patch) {
  if (patch.method) flow.request.method = String(patch.method).toUpperCase();
  if (patch.url) {
    flow.request.url = new URL(patch.url, flow.request.url).toString();
    flow.redirectedTo = flow.request.url;
  }
  if (Array.isArray(patch.headers)) {
    flow.request.headers = patch.headers.map(([k, v]) => [String(k), String(v)]);
  }
  if (patch.body !== undefined) {
    flow.request.body = decodePatchBody(patch, flow.request.body);
    flow.request.truncated = false;
    flow.request.stream = null;
    setHeader(flow.request.headers, 'content-length', String(flow.request.body.length));
    removeHeader(flow.request.headers, 'content-encoding');
  }
  if (flow.request.url) setHeader(flow.request.headers, 'host', new URL(flow.request.url).host);
  flow.modified.request = true;
}

function applyResponsePatch(flow, patch) {
  if (patch.statusCode) flow.response.statusCode = Number(patch.statusCode);
  if (patch.statusMessage !== undefined) flow.response.statusMessage = String(patch.statusMessage);
  if (Array.isArray(patch.headers)) {
    flow.response.headers = patch.headers.map(([k, v]) => [String(k), String(v)]);
  }
  if (patch.body !== undefined) {
    flow.response.body = decodePatchBody(patch, flow.response.body);
    flow.response.truncated = false;
    flow.response.stream = null;
    setHeader(flow.response.headers, 'content-length', String(flow.response.body.length));
    removeHeader(flow.response.headers, 'content-encoding');
  }
  flow.modified.response = true;
}

function detectClientSource(headers) {
  const userAgent = String(headers['user-agent'] || '');
  const hasFetchMetadata = Object.keys(headers).some((name) => name.startsWith('sec-fetch-'));
  const hasBrowserUserAgent = /Mozilla\/|Chrome\/|Chromium\/|Edg\/|Firefox\/|Safari\//i.test(userAgent);
  return hasFetchMetadata || hasBrowserUserAgent ? 'browser' : 'other';
}

function isLikelyEmailTraffic(host, port) {
  if (MAIL_PORTS.has(Number(port))) return true;
  const normalizedHost = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (MAIL_HOST_PREFIXES.some((prefix) => normalizedHost.startsWith(prefix))) return true;
  return MAIL_SERVICE_DOMAINS.some((domain) =>
    normalizedHost === domain || normalizedHost.endsWith(`.${domain}`)
  );
}

module.exports = { ProxyServer, isLikelyEmailTraffic };
