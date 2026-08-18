import { applyCorsDefaults, applyHeaders, applyJsonEdits, matchRules, prepareFulfilledHeaders } from './rule-utils';
import { DEFAULT_SETTINGS, modeForTab, Rule, Settings, TrafficRecord } from './types';

const protocolVersion = '1.3';
const attachedTabs = new Set<number>();
const requestStarts = new Map<string, number>();
const requestBodies = new Map<string, string>();
const requestHeadersById = new Map<string, Record<string, string>>();
const pending = new Map<string, { tabId: number; stage: 'request' | 'response'; params: chrome.debugger.Debuggee; event: FetchRequestPausedEvent; rules: Rule[] }>();
let trafficHandler: (record: TrafficRecord) => void = () => undefined;

type FetchHeaderEntry = { name: string; value: string };
type FetchRequestPausedEvent = {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string>; postData?: string };
  responseStatusCode?: number;
  responseHeaders?: FetchHeaderEntry[];
  resourceType?: string;
};

export interface PendingBreakpoint {
  id: string;
  tabId: number;
  stage: 'request' | 'response';
  method: string;
  url: string;
  ruleNames: string[];
}

export function onCdpTraffic(handler: (record: TrafficRecord) => void): void {
  trafficHandler = handler;
}

export function isFullInterceptionAttached(tabId: number): boolean {
  return attachedTabs.has(tabId);
}

export async function configureFullInterception(tabId: number, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!enabled) {
      if (attachedTabs.has(tabId)) await chrome.debugger.detach({ tabId });
      attachedTabs.delete(tabId);
      return { ok: true };
    }
    if (!attachedTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, protocolVersion);
      attachedTabs.add(tabId);
    }
    await send(tabId, 'Network.enable', {
      maxTotalBufferSize: 50 * 1024 * 1024,
      maxResourceBufferSize: 10 * 1024 * 1024,
      maxPostDataSize: 10 * 1024 * 1024,
      enableDurableMessages: true
    });
    await send(tabId, 'Network.setCacheDisabled', { cacheDisabled: true });
    await send(tabId, 'Network.setBypassServiceWorker', { bypass: true });
    await send(tabId, 'Fetch.enable', {
      patterns: [
        { urlPattern: 'http://*/*', requestStage: 'Request' },
        { urlPattern: 'https://*/*', requestStage: 'Request' },
        { urlPattern: 'http://*/*', requestStage: 'Response' },
        { urlPattern: 'https://*/*', requestStage: 'Response' }
      ]
    });
    await applyNetworkConditions(tabId);
    return { ok: true };
  } catch (error) {
    attachedTabs.delete(tabId);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function getPendingBreakpoints(tabId: number): PendingBreakpoint[] {
  return [...pending.entries()].filter(([, item]) => item.tabId === tabId).map(([id, item]) => ({
    id,
    tabId,
    stage: item.stage,
    method: item.event.request.method,
    url: item.event.request.url,
    ruleNames: item.rules.map((rule) => rule.name)
  }));
}

export async function continueBreakpoint(id: string): Promise<void> {
  const item = pending.get(id);
  if (!item) return;
  pending.delete(id);
  await processPausedRequest(item.tabId, item.event, item.rules, true);
  broadcastBreakpoints(item.tabId);
}

export async function syncFullMode(tabId: number): Promise<{ ok: boolean; error?: string }> {
  const settings = await getSettings();
  return configureFullInterception(tabId, settings.enabled && modeForTab(settings, tabId) === 'full');
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'Fetch.requestPaused' || source.tabId === undefined) return;
  handlePausedRequest(source.tabId, params as FetchRequestPausedEvent).catch(() => {
    const event = params as FetchRequestPausedEvent;
    const continueMethod = event.responseStatusCode === undefined ? 'Fetch.continueRequest' : 'Fetch.continueResponse';
    send(source.tabId!, continueMethod, { requestId: event.requestId }).catch(() => undefined);
  });
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    attachedTabs.delete(source.tabId);
    chrome.runtime.sendMessage({ type: 'attachment-status-changed', tabId: source.tabId, attached: false }).catch(() => undefined);
  }
});

async function handlePausedRequest(tabId: number, event: FetchRequestPausedEvent): Promise<void> {
  if (!isHttpUrl(event.request.url)) {
    const continueMethod = event.responseStatusCode === undefined ? 'Fetch.continueRequest' : 'Fetch.continueResponse';
    await send(tabId, continueMethod, { requestId: event.requestId });
    return;
  }
  const settings = await getSettings();
  const requestHeaders = new Headers(event.request.headers);
  const intendedMethod = event.request.method === 'OPTIONS' ? requestHeaders.get('access-control-request-method') || 'OPTIONS' : event.request.method;
  const rules = matchRules(settings, event.request.url, intendedMethod);
  const stage = event.responseStatusCode === undefined ? 'request' : 'response';
  if (rules.some((rule) => stage === 'request' ? rule.breakOnRequest : rule.breakOnResponse)) {
    pending.set(event.requestId, { tabId, stage, params: { tabId }, event, rules });
    broadcastBreakpoints(tabId);
    return;
  }
  await processPausedRequest(tabId, event, rules, false);
}

async function processPausedRequest(tabId: number, event: FetchRequestPausedEvent, rules: Rule[], resumed: boolean): Promise<void> {
  if (event.responseStatusCode === undefined) {
    if (event.request.method === 'OPTIONS' && rules.length) {
      const requestHeaders = new Headers(event.request.headers);
      const intendedMethod = requestHeaders.get('access-control-request-method') || 'OPTIONS';
      const headers = prepareFulfilledHeaders(applyCorsDefaults(new Headers(), requestHeaders, intendedMethod), '');
      await send(tabId, 'Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 204,
        responsePhrase: responsePhrase(204),
        responseHeaders: headerEntries(headers),
        body: ''
      });
      return;
    }
    requestStarts.set(event.requestId, Date.now());
    requestHeadersById.set(event.requestId, event.request.headers);
    let postData = event.request.postData || '';
    let headers = new Headers(event.request.headers);
    const intendedMethod = event.request.method === 'OPTIONS' ? headers.get('access-control-request-method') || 'OPTIONS' : event.request.method;
    for (const rule of rules) {
      if (rule.requestBody) postData = template(rule.requestBody, postData);
      postData = applyJsonEdits(postData, rule.requestJsonEdits);
      headers = applyHeaders(headers, rule.requestHeaders);
    }
    requestBodies.set(event.requestId, postData);
    const conditions = (await getSettings()).networkConditions;
    if (rules.some((rule) => rule.error) || conditions?.offline || Math.random() < (conditions?.failureRate || 0)) {
      await send(tabId, 'Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' });
      return;
    }
    const delay = Math.max(0, ...rules.map((rule) => rule.delayMs || 0));
    if (delay > 0 && !resumed) await wait(delay);
    await send(tabId, 'Fetch.continueRequest', {
      requestId: event.requestId,
      headers: headerEntries(headers),
      ...(postData ? { postData: toBase64(postData) } : {})
    });
    return;
  }

  const needsOriginalBody = rules.some((rule) => rule.responseBody.includes('{{body}}') || Boolean(rule.responseJsonEdits?.length))
    || !rules.some((rule) => rule.responseBody);
  let originalBody = '';
  if (needsOriginalBody) {
    const response = await send<{ body: string; base64Encoded: boolean }>(tabId, 'Fetch.getResponseBody', { requestId: event.requestId });
    originalBody = response.base64Encoded ? fromBase64(response.body) : response.body;
  }
  let body = originalBody;
  let status = event.responseStatusCode;
  let headers = new Headers(Object.fromEntries((event.responseHeaders || []).map(({ name, value }) => [name, value])));
  const requestHeaders = new Headers(requestHeadersById.get(event.requestId) || event.request.headers);
  let modified = false;
  for (const rule of rules) {
    if (rule.responseBody) { body = template(rule.responseBody, body); modified = true; }
    if (rule.responseJsonEdits?.length) { body = applyJsonEdits(body, rule.responseJsonEdits); modified = true; }
    if (rule.responseStatus) { status = rule.responseStatus; modified = true; }
    if (rule.responseHeaders && Object.keys(rule.responseHeaders).length) { headers = applyHeaders(headers, rule.responseHeaders); modified = true; }
  }
  if (modified) {
    headers = prepareFulfilledHeaders(applyCorsDefaults(headers, requestHeaders, event.request.method), body);
    await send(tabId, 'Fetch.fulfillRequest', { requestId: event.requestId, responseCode: status, responsePhrase: responsePhrase(status), responseHeaders: headerEntries(headers), body: toBase64(body) });
  } else {
    await send(tabId, 'Fetch.continueResponse', { requestId: event.requestId });
  }
  const record: TrafficRecord = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    tabId,
    frameUrl: '',
    transport: 'fetch',
    method: event.request.method,
    url: event.request.url,
    startedAt: requestStarts.get(event.requestId) || Date.now(),
    duration: Date.now() - (requestStarts.get(event.requestId) || Date.now()),
    status,
    originalStatus: event.responseStatusCode,
    requestHeaders: event.request.headers,
    requestBody: requestBodies.get(event.requestId) || event.request.postData || '',
    responseHeaders: Object.fromEntries(headers.entries()),
    responseBody: body,
    ruleIds: rules.map((rule) => rule.id),
    matchedRuleNames: rules.map((rule) => rule.name)
  };
  clearRequestState(event.requestId);
  trafficHandler(record);
}

async function applyNetworkConditions(tabId: number): Promise<void> {
  const conditions = (await getSettings()).networkConditions;
  if (!conditions) return;
  await send(tabId, 'Network.emulateNetworkConditions', {
    offline: conditions.offline,
    latency: conditions.latencyMs,
    downloadThroughput: conditions.downloadKbps > 0 ? conditions.downloadKbps * 125 : -1,
    uploadThroughput: conditions.uploadKbps > 0 ? conditions.uploadKbps * 125 : -1
  });
}

async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

function broadcastBreakpoints(tabId: number): void {
  chrome.runtime.sendMessage({ type: 'breakpoints-changed', tabId }).catch(() => undefined);
}

function headerEntries(headers: Headers): FetchHeaderEntry[] {
  return [...headers.entries()].map(([name, value]) => ({ name, value }));
}

function template(value: string, body: string): string {
  return value.replaceAll('{{body}}', body);
}

function clearRequestState(requestId: string): void {
  requestStarts.delete(requestId);
  requestBodies.delete(requestId);
  requestHeadersById.delete(requestId);
}

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): string {
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function responsePhrase(status: number): string {
  return new Map<number, string>([
    [200, 'OK'], [201, 'Created'], [202, 'Accepted'], [204, 'No Content'],
    [400, 'Bad Request'], [401, 'Unauthorized'], [403, 'Forbidden'], [404, 'Not Found'],
    [409, 'Conflict'], [422, 'Unprocessable Content'], [429, 'Too Many Requests'],
    [500, 'Internal Server Error'], [502, 'Bad Gateway'], [503, 'Service Unavailable']
  ]).get(status) || 'Network Modifier';
}

function send<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  return chrome.debugger.sendCommand({ tabId }, method, params) as unknown as Promise<T>;
}
