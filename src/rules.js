'use strict';

const fs = require('fs');
const {
  wildcardToRegExp, setHeader, addHeader, removeHeader, getHeader, mimeForPath, nextId
} = require('./util');

const REQUEST_ACTIONS = new Set([
  'redirect', 'set-method', 'set-request-header', 'add-request-header', 'remove-request-header',
  'set-request-body', 'set-query-param', 'remove-query-param', 'cancel', 'delay-request',
  'mock-response', 'map-local', 'breakpoint-request', 'throttle', 'script'
]);

const RESPONSE_ACTIONS = new Set([
  'set-status', 'set-response-header', 'add-response-header', 'remove-response-header',
  'set-response-body', 'delay-response', 'breakpoint-response', 'cors', 'throttle', 'script'
]);

const ACTION_CATALOG = [
  { type: 'redirect', phase: 'request', label: 'Redirect to URL', fields: ['url'] },
  { type: 'set-method', phase: 'request', label: 'Change request method', fields: ['method'] },
  { type: 'set-request-header', phase: 'request', label: 'Set request header', fields: ['name', 'value'] },
  { type: 'add-request-header', phase: 'request', label: 'Add request header', fields: ['name', 'value'] },
  { type: 'remove-request-header', phase: 'request', label: 'Remove request header', fields: ['name'] },
  { type: 'set-request-body', phase: 'request', label: 'Replace request body', fields: ['bodyType', 'value'] },
  { type: 'set-query-param', phase: 'request', label: 'Set query parameter', fields: ['name', 'value'] },
  { type: 'remove-query-param', phase: 'request', label: 'Remove query parameter', fields: ['name'] },
  { type: 'mock-response', phase: 'request', label: 'Mock response (do not hit network)', fields: ['status', 'bodyType', 'value', 'contentType'] },
  { type: 'map-local', phase: 'request', label: 'Map to local file', fields: ['path'] },
  { type: 'cancel', phase: 'request', label: 'Cancel / block request', fields: ['reason'] },
  { type: 'delay-request', phase: 'request', label: 'Delay before sending request', fields: ['ms'] },
  { type: 'breakpoint-request', phase: 'request', label: 'Breakpoint on request', fields: [] },
  { type: 'set-status', phase: 'response', label: 'Replace response status', fields: ['status', 'statusMessage'] },
  { type: 'set-response-header', phase: 'response', label: 'Set response header', fields: ['name', 'value'] },
  { type: 'add-response-header', phase: 'response', label: 'Add response header', fields: ['name', 'value'] },
  { type: 'remove-response-header', phase: 'response', label: 'Remove response header', fields: ['name'] },
  { type: 'set-response-body', phase: 'response', label: 'Replace response body', fields: ['bodyType', 'value', 'contentType'] },
  { type: 'delay-response', phase: 'response', label: 'Delay response', fields: ['ms'] },
  { type: 'breakpoint-response', phase: 'response', label: 'Breakpoint on response', fields: [] },
  { type: 'cors', phase: 'response', label: 'Allow CORS', fields: ['origin'] },
  { type: 'throttle', phase: 'both', label: 'Throttle bandwidth', fields: ['bytesPerSecond'] },
  { type: 'script', phase: 'both', label: 'Run script', fields: ['code'] }
];

function makeRule(partial = {}) {
  return {
    id: partial.id || nextId('r'),
    name: partial.name || 'New rule',
    enabled: partial.enabled !== false,
    profile: partial.profile || 'default',
    folder: partial.folder || '',
    priority: Number.isFinite(Number(partial.priority)) ? Number(partial.priority) : 0,
    match: {
      urlPattern: '',
      matchType: 'contains',
      caseSensitive: false,
      negate: false,
      methods: [],
      resourceTypes: [],
      statusCodes: [],
      protocol: 'any',
      ...(partial.match || {})
    },
    actions: Array.isArray(partial.actions) ? partial.actions.map((a) => ({ ...a })) : []
  };
}

class RuleMatchError extends Error {}

/** Evaluates the match block of a rule. Returns null or the capture array. */
function matchRule(rule, flow, phase) {
  const m = rule.match || {};
  let captures = [];
  const url = flow.request.url;

  if (m.protocol && m.protocol !== 'any') {
    const scheme = url.startsWith('https:') ? 'https' : 'http';
    if (scheme !== m.protocol) return fail(m);
  }
  if (Array.isArray(m.methods) && m.methods.length) {
    if (!m.methods.map((x) => x.toUpperCase()).includes(flow.request.method.toUpperCase())) return fail(m);
  }
  if (Array.isArray(m.resourceTypes) && m.resourceTypes.length) {
    if (!m.resourceTypes.includes(flow.resourceType)) return fail(m);
  }
  if (phase === 'response' && Array.isArray(m.statusCodes) && m.statusCodes.length) {
    const status = flow.response ? flow.response.statusCode : 0;
    const ok = m.statusCodes.some((spec) => statusMatches(String(spec), status));
    if (!ok) return fail(m);
  }
  if (m.urlPattern) {
    const result = matchUrl(url, m);
    if (!result) return fail(m);
    captures = result;
  }
  return m.negate ? null : captures;
}

function fail(m) {
  return m.negate ? [] : null;
}

function statusMatches(spec, status) {
  if (/^\d{3}$/.test(spec)) return Number(spec) === status;
  if (/^\dxx$/i.test(spec)) return Math.floor(status / 100) === Number(spec[0]);
  const range = spec.split('-').map((n) => Number(n.trim()));
  if (range.length === 2 && range.every((n) => Number.isFinite(n))) {
    return status >= range[0] && status <= range[1];
  }
  return false;
}

function matchUrl(url, m) {
  const flags = m.caseSensitive ? '' : 'i';
  const pattern = m.urlPattern;
  switch (m.matchType) {
    case 'exact':
      return compare(url, pattern, m.caseSensitive) ? [] : null;
    case 'wildcard': {
      const found = wildcardToRegExp(pattern, flags).exec(url);
      return found ? found.slice(1) : null;
    }
    case 'regex': {
      let re;
      try {
        re = new RegExp(pattern, flags);
      } catch (err) {
        throw new RuleMatchError(`Invalid regex: ${err.message}`);
      }
      const found = re.exec(url);
      return found ? found.slice(1) : null;
    }
    case 'host': {
      let host;
      try { host = new URL(url).host; } catch { host = ''; }
      return wildcardToRegExp(pattern, flags).test(host) ? [] : null;
    }
    case 'contains':
    default: {
      const haystack = m.caseSensitive ? url : url.toLowerCase();
      const needle = m.caseSensitive ? pattern : pattern.toLowerCase();
      return haystack.includes(needle) ? [] : null;
    }
  }
}

function compare(a, b, caseSensitive) {
  return caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
}

/** Expands $1..$9 captures and {{token}} placeholders inside rule values. */
function interpolate(template, captures, flow) {
  if (typeof template !== 'string') return template;
  let url;
  try { url = new URL(flow.request.url); } catch { url = null; }
  return template
    .replace(/\$(\d)/g, (all, i) => {
      const value = captures[Number(i) - 1];
      return value === undefined ? all : value;
    })
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, token) => {
      switch (token) {
        case 'url': return flow.request.url;
        case 'method': return flow.request.method;
        case 'host': return url ? url.host : '';
        case 'hostname': return url ? url.hostname : '';
        case 'port': return url ? url.port : '';
        case 'protocol': return url ? url.protocol.replace(':', '') : '';
        case 'path': return url ? url.pathname : '';
        case 'query': return url ? url.search.replace(/^\?/, '') : '';
        case 'pathAndQuery': return url ? url.pathname + url.search : '';
        case 'id': return flow.id;
        case 'timestamp': return String(Date.now());
        default: return all;
      }
    });
}

function buildBody(action, captures, flow) {
  const type = action.bodyType || 'text';
  const raw = action.value === undefined ? '' : action.value;
  switch (type) {
    case 'base64':
      return { buffer: Buffer.from(String(raw).replace(/\s+/g, ''), 'base64'), contentType: action.contentType };
    case 'json': {
      const text = interpolate(String(raw), captures, flow);
      JSON.parse(text); // fail loudly on malformed rule JSON
      return { buffer: Buffer.from(text, 'utf8'), contentType: action.contentType || 'application/json; charset=utf-8' };
    }
    case 'form': {
      const params = new URLSearchParams();
      const fields = Array.isArray(action.fields) ? action.fields : parseFormText(String(raw));
      for (const field of fields) {
        params.append(field.name, interpolate(String(field.value ?? ''), captures, flow));
      }
      return {
        buffer: Buffer.from(params.toString(), 'utf8'),
        contentType: action.contentType || 'application/x-www-form-urlencoded'
      };
    }
    case 'file': {
      const filePath = interpolate(String(action.path || raw), captures, flow);
      return { buffer: fs.readFileSync(filePath), contentType: action.contentType || mimeForPath(filePath) };
    }
    case 'text':
    default:
      return {
        buffer: Buffer.from(interpolate(String(raw), captures, flow), 'utf8'),
        contentType: action.contentType
      };
  }
}

function parseFormText(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return index === -1
      ? { name: line.trim(), value: '' }
      : { name: line.slice(0, index).trim(), value: line.slice(index + 1) };
  });
}

function applyBodyToRequest(flow, body) {
  flow.request.body = body.buffer;
  flow.request.truncated = false;
  flow.request.stream = null;
  if (body.contentType) setHeader(flow.request.headers, 'content-type', body.contentType);
  setHeader(flow.request.headers, 'content-length', String(body.buffer.length));
  removeHeader(flow.request.headers, 'transfer-encoding');
  removeHeader(flow.request.headers, 'content-encoding');
  flow.modified.request = true;
}

function applyBodyToResponse(flow, body) {
  flow.response.body = body.buffer;
  flow.response.truncated = false;
  flow.response.stream = null;
  if (body.contentType) setHeader(flow.response.headers, 'content-type', body.contentType);
  setHeader(flow.response.headers, 'content-length', String(body.buffer.length));
  removeHeader(flow.response.headers, 'transfer-encoding');
  removeHeader(flow.response.headers, 'content-encoding');
  flow.modified.response = true;
}

class RuleEngine {
  constructor({ scriptEngine, onScriptLog }) {
    this.rules = [];
    this.activeProfiles = new Set(['*']);
    this.scriptEngine = scriptEngine;
    this.onScriptLog = onScriptLog || (() => {});
  }

  setRules(rules) {
    this.rules = rules.map(makeRule).sort((left, right) => right.priority - left.priority);
  }

  setActiveProfiles(profiles) {
    this.activeProfiles = new Set(Array.isArray(profiles) && profiles.length ? profiles : ['*']);
  }

  apply(flow, phase) {
    const result = {
      cancel: false, cancelReason: '', breakpoint: false, delayMs: 0,
      mock: null, throttle: 0, applied: [], errors: []
    };

    for (const rule of this.rules) {
      const allProfiles = this.activeProfiles.has('*');
      if (!rule.enabled || (!allProfiles && !this.activeProfiles.has(rule.profile || 'default'))) continue;
      let captures;
      try {
        captures = matchRule(rule, flow, phase);
      } catch (err) {
        result.errors.push(`${rule.name}: ${err.message}`);
        continue;
      }
      if (!captures) continue;

      let matchedAction = false;
      for (const action of rule.actions || []) {
        const set = phase === 'request' ? REQUEST_ACTIONS : RESPONSE_ACTIONS;
        if (!set.has(action.type)) continue;
        matchedAction = true;
        try {
          this.applyAction(action, flow, phase, captures, result);
        } catch (err) {
          result.errors.push(`${rule.name} / ${action.type}: ${err.message}`);
        }
        if (result.cancel || result.mock) break;
      }
      if (matchedAction) result.applied.push({ id: rule.id, name: rule.name, phase });
      if (result.cancel || result.mock) break;
    }
    return result;
  }

  applyAction(action, flow, phase, captures, result) {
    const req = flow.request;
    const res = flow.response;
    switch (action.type) {
      case 'redirect': {
        const target = interpolate(String(action.url || ''), captures, flow);
        if (!target) throw new Error('redirect target is empty');
        const resolved = new URL(target, req.url).toString();
        req.url = resolved;
        setHeader(req.headers, 'host', new URL(resolved).host);
        flow.modified.request = true;
        flow.redirectedTo = resolved;
        break;
      }
      case 'set-method':
        req.method = String(action.method || 'GET').toUpperCase();
        flow.modified.request = true;
        break;
      case 'set-request-header':
        setHeader(req.headers, action.name, interpolate(String(action.value ?? ''), captures, flow));
        flow.modified.request = true;
        break;
      case 'add-request-header':
        addHeader(req.headers, action.name, interpolate(String(action.value ?? ''), captures, flow));
        flow.modified.request = true;
        break;
      case 'remove-request-header':
        removeHeader(req.headers, action.name);
        flow.modified.request = true;
        break;
      case 'set-request-body':
        applyBodyToRequest(flow, buildBody(action, captures, flow));
        break;
      case 'set-query-param': {
        const url = new URL(req.url);
        url.searchParams.set(action.name, interpolate(String(action.value ?? ''), captures, flow));
        req.url = url.toString();
        flow.modified.request = true;
        break;
      }
      case 'remove-query-param': {
        const url = new URL(req.url);
        url.searchParams.delete(action.name);
        req.url = url.toString();
        flow.modified.request = true;
        break;
      }
      case 'cancel':
        result.cancel = true;
        result.cancelReason = action.reason || 'Cancelled by rule';
        break;
      case 'delay-request':
      case 'delay-response':
        result.delayMs += Number(action.ms) || 0;
        break;
      case 'throttle':
        result.throttle = Number(action.bytesPerSecond) || 0;
        break;
      case 'breakpoint-request':
      case 'breakpoint-response':
        result.breakpoint = true;
        break;
      case 'map-local': {
        const body = buildBody({ bodyType: 'file', path: action.path, contentType: action.contentType }, captures, flow);
        result.mock = {
          statusCode: Number(action.status) || 200,
          statusMessage: 'OK',
          headers: [['content-type', body.contentType], ['content-length', String(body.buffer.length)]],
          body: body.buffer
        };
        break;
      }
      case 'mock-response': {
        const body = buildBody(action, captures, flow);
        const headers = [];
        if (body.contentType) headers.push(['content-type', body.contentType]);
        headers.push(['content-length', String(body.buffer.length)]);
        for (const h of action.headers || []) headers.push([h.name, interpolate(String(h.value ?? ''), captures, flow)]);
        result.mock = {
          statusCode: Number(action.status) || 200,
          statusMessage: action.statusMessage || '',
          headers,
          body: body.buffer
        };
        break;
      }
      case 'set-status':
        res.statusCode = Number(action.status) || res.statusCode;
        if (action.statusMessage !== undefined) res.statusMessage = String(action.statusMessage);
        flow.modified.response = true;
        break;
      case 'set-response-header':
        setHeader(res.headers, action.name, interpolate(String(action.value ?? ''), captures, flow));
        flow.modified.response = true;
        break;
      case 'add-response-header':
        addHeader(res.headers, action.name, interpolate(String(action.value ?? ''), captures, flow));
        flow.modified.response = true;
        break;
      case 'remove-response-header':
        removeHeader(res.headers, action.name);
        flow.modified.response = true;
        break;
      case 'set-response-body':
        applyBodyToResponse(flow, buildBody(action, captures, flow));
        break;
      case 'cors': {
        const origin = action.origin || getHeader(req.headers, 'origin') || '*';
        setHeader(res.headers, 'access-control-allow-origin', origin);
        setHeader(res.headers, 'access-control-allow-credentials', 'true');
        setHeader(res.headers, 'access-control-allow-headers', action.headers || '*');
        setHeader(res.headers, 'access-control-allow-methods', action.methods || 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        flow.modified.response = true;
        break;
      }
      case 'script':
        this.runScript(action.code || '', flow, phase, result);
        break;
      default:
        throw new Error(`Unknown action "${action.type}"`);
    }
  }

  runScript(code, flow, phase, result) {
    const ctx = createScriptContext(flow, phase, result);
    this.scriptEngine.run(code, ctx, { flowId: flow.id, phase });
  }
}

function headerView(pairs) {
  const view = {};
  for (const [name, value] of pairs) {
    const key = name.toLowerCase();
    view[key] = view[key] === undefined ? value : `${view[key]}, ${value}`;
  }
  return view;
}

function createScriptContext(flow, phase, result) {
  const request = {
    get method() { return flow.request.method; },
    set method(value) { flow.request.method = String(value).toUpperCase(); flow.modified.request = true; },
    get url() { return flow.request.url; },
    set url(value) {
      flow.request.url = new URL(String(value), flow.request.url).toString();
      setHeader(flow.request.headers, 'host', new URL(flow.request.url).host);
      flow.modified.request = true;
    },
    get headers() { return headerView(flow.request.headers); },
    get body() { return flow.request.body ? flow.request.body.toString('utf8') : ''; },
    set body(value) { applyBodyToRequest(flow, { buffer: Buffer.from(String(value), 'utf8') }); },
    get json() {
      try { return JSON.parse(request.body); } catch { return undefined; }
    },
    set json(value) {
      applyBodyToRequest(flow, {
        buffer: Buffer.from(JSON.stringify(value), 'utf8'),
        contentType: 'application/json; charset=utf-8'
      });
    },
    get query() {
      try { return Object.fromEntries(new URL(flow.request.url).searchParams); } catch { return {}; }
    },
    getHeader: (name) => getHeader(flow.request.headers, name),
    setHeader: (name, value) => { setHeader(flow.request.headers, name, value); flow.modified.request = true; },
    addHeader: (name, value) => { addHeader(flow.request.headers, name, value); flow.modified.request = true; },
    removeHeader: (name) => { removeHeader(flow.request.headers, name); flow.modified.request = true; },
    setQueryParam: (name, value) => {
      const url = new URL(flow.request.url);
      url.searchParams.set(name, value);
      flow.request.url = url.toString();
      flow.modified.request = true;
    },
    redirect: (target) => { request.url = target; flow.redirectedTo = flow.request.url; },
    setBodyBase64: (value) => applyBodyToRequest(flow, { buffer: Buffer.from(String(value), 'base64') })
  };

  const response = flow.response ? {
    get status() { return flow.response.statusCode; },
    set status(value) { flow.response.statusCode = Number(value); flow.modified.response = true; },
    get statusMessage() { return flow.response.statusMessage; },
    set statusMessage(value) { flow.response.statusMessage = String(value); flow.modified.response = true; },
    get headers() { return headerView(flow.response.headers); },
    get body() { return flow.response.body ? flow.response.body.toString('utf8') : ''; },
    set body(value) { applyBodyToResponse(flow, { buffer: Buffer.from(String(value), 'utf8') }); },
    get json() {
      try { return JSON.parse(response.body); } catch { return undefined; }
    },
    set json(value) {
      applyBodyToResponse(flow, {
        buffer: Buffer.from(JSON.stringify(value), 'utf8'),
        contentType: 'application/json; charset=utf-8'
      });
    },
    getHeader: (name) => getHeader(flow.response.headers, name),
    setHeader: (name, value) => { setHeader(flow.response.headers, name, value); flow.modified.response = true; },
    addHeader: (name, value) => { addHeader(flow.response.headers, name, value); flow.modified.response = true; },
    removeHeader: (name) => { removeHeader(flow.response.headers, name); flow.modified.response = true; },
    setBodyBase64: (value) => applyBodyToResponse(flow, { buffer: Buffer.from(String(value), 'base64') })
  } : null;

  return {
    phase,
    id: flow.id,
    resourceType: flow.resourceType,
    request,
    response,
    cancel: (reason) => { result.cancel = true; result.cancelReason = reason || 'Cancelled by script'; },
    delay: (ms) => { result.delayMs += Number(ms) || 0; },
    throttle: (bps) => { result.throttle = Number(bps) || 0; },
    breakpoint: () => { result.breakpoint = true; },
    mock: (spec = {}) => {
      const buffer = Buffer.isBuffer(spec.body)
        ? spec.body
        : Buffer.from(typeof spec.body === 'object' && spec.body !== null ? JSON.stringify(spec.body) : String(spec.body ?? ''), 'utf8');
      const headers = Object.entries(spec.headers || {}).map(([k, v]) => [k, String(v)]);
      if (!headers.some(([k]) => k.toLowerCase() === 'content-type') && typeof spec.body === 'object') {
        headers.push(['content-type', 'application/json; charset=utf-8']);
      }
      headers.push(['content-length', String(buffer.length)]);
      result.mock = {
        statusCode: Number(spec.status) || 200,
        statusMessage: spec.statusMessage || '',
        headers,
        body: buffer
      };
    }
  };
}

module.exports = {
  RuleEngine,
  makeRule,
  matchRule,
  interpolate,
  buildBody,
  applyBodyToRequest,
  applyBodyToResponse,
  ACTION_CATALOG,
  REQUEST_ACTIONS,
  RESPONSE_ACTIONS
};
