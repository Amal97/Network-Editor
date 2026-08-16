'use strict';

const { EventEmitter } = require('events');
const { isProbablyText, getHeader } = require('./util');

class FlowStore extends EventEmitter {
  constructor({ maxFlows = 2000 } = {}) {
    super();
    this.maxFlows = maxFlows;
    this.flows = [];
    this.byId = new Map();
    this.seq = 0;
  }

  setMax(maxFlows) {
    this.maxFlows = maxFlows;
    this.trim();
  }

  add(flow) {
    flow.seq = ++this.seq;
    this.flows.push(flow);
    this.byId.set(flow.id, flow);
    this.trim();
    this.emit('flow', { type: 'new', flow: summarize(flow) });
    return flow;
  }

  touch(flow) {
    if (!this.byId.has(flow.id)) return;
    flow.seq = ++this.seq;
    this.emit('flow', { type: 'update', flow: summarize(flow) });
  }

  get(id) {
    return this.byId.get(id);
  }

  list({ since = 0, limit = 5000 } = {}) {
    const out = [];
    for (let i = this.flows.length - 1; i >= 0 && out.length < limit; i--) {
      if (this.flows[i].seq > since) out.push(summarize(this.flows[i]));
    }
    return out.reverse();
  }

  search(query, { limit = 5000 } = {}) {
    const text = String(query || '').trim();
    if (!text) return this.list({ limit });
    const out = [];
    for (let i = this.flows.length - 1; i >= 0 && out.length < limit; i--) {
      if (flowMatches(this.flows[i], text)) out.push(summarize(this.flows[i]));
    }
    return out.reverse();
  }

  clear() {
    this.flows = [];
    this.byId.clear();
    this.emit('cleared');
  }

  remove(ids) {
    const set = new Set(ids);
    const removed = [];
    this.flows = this.flows.filter((flow) => {
      if (!set.has(flow.id)) return true;
      this.byId.delete(flow.id);
      removed.push(flow.id);
      return false;
    });
    if (removed.length) this.emit('removed', removed);
    return removed;
  }

  snapshot() {
    return this.flows.map((flow) => serializeFlow(flow));
  }

  restore(snapshot) {
    this.clear();
    for (const record of snapshot || []) {
      const flow = deserializeFlow(record);
      flow.seq = ++this.seq;
      this.flows.push(flow);
      this.byId.set(flow.id, flow);
      this.emit('flow', { type: 'new', flow: summarize(flow) });
    }
    this.trim();
    return this.flows.length;
  }

  trim() {
    while (this.flows.length > this.maxFlows) {
      const removed = this.flows.shift();
      this.byId.delete(removed.id);
    }
  }
}

function summarize(flow) {
  const clientSource = flow.clientSource || detectClientSource(flow.request.headers);
  return {
    id: flow.id,
    seq: flow.seq,
    method: flow.request.method,
    url: flow.request.url,
    host: safe(() => new URL(flow.request.url).host, ''),
    path: safe(() => new URL(flow.request.url).pathname + new URL(flow.request.url).search, flow.request.url),
    scheme: flow.request.url.startsWith('https:') ? 'https' : 'http',
    resourceType: flow.resourceType,
    state: flow.state,
    status: flow.response ? flow.response.statusCode : null,
    statusMessage: flow.response ? flow.response.statusMessage : null,
    contentType: flow.response ? String(getHeader(flow.response.headers, 'content-type') || '').split(';')[0] : '',
    requestSize: flow.request.body ? flow.request.body.length : flow.request.size || 0,
    responseSize: flow.response ? (flow.response.body ? flow.response.body.length : flow.response.size || 0) : 0,
    startTime: flow.startTime,
    endTime: flow.endTime || null,
    duration: flow.endTime ? flow.endTime - flow.startTime : null,
    modified: { ...flow.modified },
    rulesApplied: flow.rulesApplied,
    redirectedTo: flow.redirectedTo || null,
    error: flow.error || null,
    clientIp: flow.clientIp,
    clientSource,
    pausedPhase: flow.pausedPhase || null
  };
}

function detectClientSource(headers) {
  const userAgent = String(getHeader(headers || [], 'user-agent') || '');
  const hasFetchMetadata = (headers || []).some(([name]) => String(name).toLowerCase().startsWith('sec-fetch-'));
  const hasBrowserUserAgent = /Mozilla\/|Chrome\/|Chromium\/|Edg\/|Firefox\/|Safari\//i.test(userAgent);
  return hasFetchMetadata || hasBrowserUserAgent ? 'browser' : 'other';
}

function detail(flow) {
  return {
    ...summarize(flow),
    request: serializeMessage(flow.request),
    response: flow.response ? serializeMessage(flow.response) : null,
    originalRequest: flow.originalRequest ? serializeMessage(flow.originalRequest) : null,
    originalResponse: flow.originalResponse ? serializeMessage(flow.originalResponse) : null,
    webSocketFrames: flow.webSocketFrames || [],
    timing: flow.timing || {},
    errors: flow.errors || []
  };
}

function serializeMessage(message) {
  return {
    method: message.method,
    url: message.url,
    statusCode: message.statusCode,
    statusMessage: message.statusMessage,
    httpVersion: message.httpVersion,
    headers: message.headers,
    ...encodeBody(message.body, getHeader(message.headers, 'content-type'), message.truncated)
  };
}

function serializeFlow(flow) {
  return JSON.parse(JSON.stringify(flow, (key, value) => {
    if (Buffer.isBuffer(value)) return { __netmodBuffer: value.toString('base64') };
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
      return { __netmodBuffer: Buffer.from(value.data).toString('base64') };
    }
    if (key === 'stream') return null;
    return value;
  }));
}

function deserializeFlow(record) {
  return JSON.parse(JSON.stringify(record), (key, value) => {
    if (value && value.__netmodBuffer !== undefined) return Buffer.from(value.__netmodBuffer, 'base64');
    return value;
  });
}

function encodeBody(buffer, contentType, truncated) {
  if (truncated) return { body: '', bodyEncoding: 'none', bodyTruncated: true, bodySize: 0 };
  if (!buffer || buffer.length === 0) return { body: '', bodyEncoding: 'text', bodyTruncated: false, bodySize: 0 };
  const text = isProbablyText(contentType, buffer);
  return {
    body: text ? buffer.toString('utf8') : buffer.toString('base64'),
    bodyEncoding: text ? 'text' : 'base64',
    bodyTruncated: false,
    bodySize: buffer.length
  };
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function flowMatches(flow, query) {
  const jsonQuery = /^(?:(request|response)\.)?(\$\.[\w.[\]-]+)(?:=(.*))?$/.exec(query);
  if (jsonQuery) {
    const sides = jsonQuery[1] ? [flow[jsonQuery[1]]] : [flow.request, flow.response];
    return sides.some((side) => jsonPathMatches(side, jsonQuery[2], jsonQuery[3]));
  }
  const needle = query.toLowerCase();
  const messages = [flow.request, flow.response].filter(Boolean);
  const haystack = [
    flow.request.url,
    flow.request.method,
    flow.response && flow.response.statusCode,
    ...messages.flatMap((message) => message.headers.flatMap(([name, value]) => [name, value])),
    ...messages.map((message) => bodyText(message))
  ].join('\n').toLowerCase();
  return haystack.includes(needle);
}

function jsonPathMatches(message, path, expected) {
  if (!message || !message.body || message.truncated) return false;
  let value;
  try {
    value = JSON.parse(message.body.toString('utf8'));
  } catch {
    return false;
  }
  const parts = path.slice(2).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  for (const part of parts) {
    if (value === null || value === undefined || !Object.prototype.hasOwnProperty.call(Object(value), part)) return false;
    value = value[part];
  }
  return expected === undefined || String(value).toLowerCase().includes(expected.toLowerCase());
}

function bodyText(message) {
  if (!message.body || message.truncated || !isProbablyText(getHeader(message.headers, 'content-type'), message.body)) return '';
  return message.body.toString('utf8');
}

module.exports = { FlowStore, summarize, detail };
