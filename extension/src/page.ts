import { DEFAULT_SETTINGS, Rule, Settings, TrafficRecord } from './types';
import { applyHeaders, applyJsonEdits, matchRules } from './rule-utils';

let settings: Settings = DEFAULT_SETTINGS;
const originalFetch = window.fetch.bind(window);
const OriginalXHR = window.XMLHttpRequest;

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'network-modifier-extension' || event.data.type !== 'config') return;
  settings = { ...DEFAULT_SETTINGS, ...event.data.settings };
});

window.postMessage({ source: 'network-modifier-page', type: 'config-request' }, '*');

function matchingRules(url: string, method: string): Rule[] {
  if (settings.interceptionMode === 'full') return [];
  return matchRules(settings, url, method);
}

function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function emit(record: TrafficRecord) {
  window.postMessage({ source: 'network-modifier-page', type: 'traffic', record }, '*');
}

function id() {
  return `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyNetworkConditions(): Promise<void> {
  const conditions = settings.networkConditions;
  if (!conditions) return;
  if (conditions.offline || Math.random() < conditions.failureRate) throw new TypeError('Network request failed by Network Modifier');
  if (conditions.latencyMs > 0) await sleep(conditions.latencyMs);
}

async function throttleBody(body: string, kilobitsPerSecond: number): Promise<void> {
  if (kilobitsPerSecond <= 0 || !body) return;
  await sleep(Math.ceil((new TextEncoder().encode(body).byteLength * 8) / kilobitsPerSecond));
}

function pauseAtBreakpoint(kind: 'request' | 'response', rules: Rule[]): void {
  if (rules.some((rule) => kind === 'request' ? rule.breakOnRequest : rule.breakOnResponse)) {
    debugger;
  }
}

function applyTemplate(template: string, original: string): string {
  return template.replaceAll('{{body}}', original);
}

async function readRequestBody(request: Request): Promise<string> {
  if (request.method === 'GET' || request.method === 'HEAD') return '';
  try { return await request.clone().text(); } catch { return ''; }
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const startedAt = Date.now();
  let request = new Request(input, init);
  const rules = matchingRules(request.url, request.method);
  await applyNetworkConditions();
  pauseAtBreakpoint('request', rules);
  const originalRequestBody = await readRequestBody(request);
  let requestBody = originalRequestBody;

  for (const rule of rules) {
    if (rule.delayMs > 0) await sleep(rule.delayMs);
    if (rule.error) {
      const message = `Blocked by Network Modifier: ${rule.name}`;
      emit({ id: id(), frameUrl: location.href, transport: 'fetch', method: request.method, url: request.url, startedAt, duration: Date.now() - startedAt, status: 0, requestHeaders: headersToObject(request.headers), requestBody, responseHeaders: {}, responseBody: '', ruleIds: rules.map((item) => item.id), error: message });
      throw new TypeError(message);
    }
    if (rule.requestBody && !['GET', 'HEAD'].includes(request.method)) requestBody = applyTemplate(rule.requestBody, requestBody);
  }

  if (requestBody !== originalRequestBody) {
    let headers = new Headers(request.headers);
    for (const rule of rules) headers = applyHeaders(headers, rule.requestHeaders);
    headers.delete('content-length');
    request = new Request(request, { body: requestBody, headers });
  } else if (rules.some((rule) => rule.requestHeaders && Object.keys(rule.requestHeaders).length)) {
    let headers = new Headers(request.headers);
    for (const rule of rules) headers = applyHeaders(headers, rule.requestHeaders);
    request = new Request(request, { headers });
  }

  for (const rule of rules) requestBody = applyJsonEdits(requestBody, rule.requestJsonEdits);
  if (requestBody !== originalRequestBody && !['GET', 'HEAD'].includes(request.method)) request = new Request(request, { body: requestBody });
  await throttleBody(requestBody, settings.networkConditions?.uploadKbps || 0);

  try {
    let response: Response;
    const mockRule = [...rules].reverse().find((rule) => rule.responseBody || rule.responseStatus);
    if (mockRule?.responseBody && mockRule.responseStatus) {
      response = new Response(applyTemplate(mockRule.responseBody, ''), { status: mockRule.responseStatus, headers: { 'content-type': 'application/json', 'x-network-modifier': 'mock' } });
    } else {
      response = await originalFetch(request);
    }

    const originalResponseBody = await response.clone().text();
    const originalStatus = response.status;
    let responseBody = originalResponseBody;
    let status = response.status;
    let modified = false;
    for (const rule of rules) {
      if (rule.responseBody) { responseBody = applyTemplate(rule.responseBody, responseBody); modified = true; }
      if (rule.responseJsonEdits?.length) { responseBody = applyJsonEdits(responseBody, rule.responseJsonEdits); modified = true; }
      if (rule.responseStatus) { status = rule.responseStatus; modified = true; }
    }
    let responseHeaders = new Headers(response.headers);
    for (const rule of rules) responseHeaders = applyHeaders(responseHeaders, rule.responseHeaders);
    if (rules.some((rule) => rule.responseHeaders && Object.keys(rule.responseHeaders).length)) modified = true;
    await throttleBody(responseBody, settings.networkConditions?.downloadKbps || 0);
    pauseAtBreakpoint('response', rules);
    const finalResponse = modified ? new Response([204, 205, 304].includes(status) ? null : responseBody, { status, statusText: response.statusText, headers: responseHeaders }) : response;
    emit({ id: id(), frameUrl: location.href, transport: 'fetch', method: request.method, url: request.url, startedAt, duration: Date.now() - startedAt, status, originalStatus, requestHeaders: headersToObject(request.headers), requestBody, responseHeaders: headersToObject(finalResponse.headers), responseBody, ruleIds: rules.map((rule) => rule.id) });
    return finalResponse;
  } catch (error) {
    emit({ id: id(), frameUrl: location.href, transport: 'fetch', method: request.method, url: request.url, startedAt, duration: Date.now() - startedAt, status: 0, requestHeaders: headersToObject(request.headers), requestBody, responseHeaders: {}, responseBody: '', ruleIds: rules.map((rule) => rule.id), error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
};

const metadata = new WeakMap<XMLHttpRequest, { method: string; url: string; startedAt: number; requestBody: string; rules: Rule[] }>();
const originalOpen = OriginalXHR.prototype.open;
const originalSend = OriginalXHR.prototype.send;

OriginalXHR.prototype.open = function(method: string, url: string | URL, ...rest: unknown[]) {
  const absoluteUrl = new URL(String(url), location.href).href;
  metadata.set(this, { method: method.toUpperCase(), url: absoluteUrl, startedAt: 0, requestBody: '', rules: matchingRules(absoluteUrl, method) });
  this.addEventListener('readystatechange', () => {
    if (this.readyState !== 4) return;
    const meta = metadata.get(this);
    if (!meta) return;
    let responseBody = typeof this.responseText === 'string' ? this.responseText : '';
    const originalStatus = this.status;
    let status = originalStatus;
    for (const rule of meta.rules) {
      if (rule.responseBody) responseBody = applyTemplate(rule.responseBody, responseBody);
      if (rule.responseStatus) status = rule.responseStatus;
    }
    try {
      if (responseBody !== this.responseText) {
        Object.defineProperty(this, 'responseText', { configurable: true, value: responseBody });
        Object.defineProperty(this, 'response', { configurable: true, value: responseBody });
      }
      if (status !== this.status) Object.defineProperty(this, 'status', { configurable: true, value: status });
    } catch { /* Native properties can be non-configurable in some Chrome versions. */ }
    emit({ id: id(), frameUrl: location.href, transport: 'xhr', method: meta.method, url: meta.url, startedAt: meta.startedAt, duration: Date.now() - meta.startedAt, status, originalStatus, requestHeaders: {}, requestBody: meta.requestBody, responseHeaders: parseRawHeaders(this.getAllResponseHeaders()), responseBody, ruleIds: meta.rules.map((rule) => rule.id) });
  });
  return originalOpen.call(this, method, url, ...(rest as [boolean, string | null | undefined, string | null | undefined]));
};

OriginalXHR.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
  const meta = metadata.get(this);
  if (!meta) return originalSend.call(this, body);
  meta.startedAt = Date.now();
  meta.requestBody = typeof body === 'string' ? body : '';
  for (const rule of meta.rules) if (rule.requestBody) meta.requestBody = applyTemplate(rule.requestBody, meta.requestBody);
  for (const rule of meta.rules) meta.requestBody = applyJsonEdits(meta.requestBody, rule.requestJsonEdits);
  for (const rule of meta.rules) for (const [name, value] of Object.entries(rule.requestHeaders || {})) if (value) this.setRequestHeader(name, value);
  pauseAtBreakpoint('request', meta.rules);
  return originalSend.call(this, meta.requestBody || body);
};

function parseRawHeaders(value: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of value.trim().split(/[\r\n]+/)) {
    const index = line.indexOf(':');
    if (index > 0) output[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return output;
}
