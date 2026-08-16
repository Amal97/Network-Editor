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
    request: {
      method: flow.request.method,
      url: flow.request.url,
      httpVersion: flow.request.httpVersion,
      headers: flow.request.headers,
      ...encodeBody(flow.request.body, getHeader(flow.request.headers, 'content-type'), flow.request.truncated)
    },
    response: flow.response ? {
      statusCode: flow.response.statusCode,
      statusMessage: flow.response.statusMessage,
      httpVersion: flow.response.httpVersion,
      headers: flow.response.headers,
      ...encodeBody(flow.response.body, getHeader(flow.response.headers, 'content-type'), flow.response.truncated)
    } : null,
    timing: flow.timing || {},
    errors: flow.errors || []
  };
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

module.exports = { FlowStore, summarize, detail };
