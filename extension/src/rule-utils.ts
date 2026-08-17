import { HeaderMap, JsonEdit, Rule, Settings, TrafficRecord } from './types';

export interface RuleDiagnostic {
  ruleId: string;
  severity: 'error' | 'warning';
  message: string;
}

export const RESPONSE_PRESETS = [
  { name: 'Unauthorized', status: 401, body: '{\n  "error": "Unauthorized"\n}' },
  { name: 'Forbidden', status: 403, body: '{\n  "error": "Forbidden"\n}' },
  { name: 'Not found', status: 404, body: '{\n  "error": "Not found"\n}' },
  { name: 'Rate limited', status: 429, body: '{\n  "error": "Too many requests"\n}' },
  { name: 'Server error', status: 500, body: '{\n  "error": "Internal server error"\n}' }
] as const;

export const NETWORK_PRESETS = {
  Online: { offline: false, latencyMs: 0, downloadKbps: 0, uploadKbps: 0, failureRate: 0 },
  'Slow 3G': { offline: false, latencyMs: 400, downloadKbps: 400, uploadKbps: 400, failureRate: 0 },
  'Fast 3G': { offline: false, latencyMs: 150, downloadKbps: 1600, uploadKbps: 750, failureRate: 0 },
  Offline: { offline: true, latencyMs: 0, downloadKbps: 0, uploadKbps: 0, failureRate: 1 }
} as const;

export function matchRules(settings: Settings, url: string, method: string): Rule[] {
  if (!settings.enabled) return [];
  const activeProfiles = settings.activeProfiles?.length ? settings.activeProfiles : ['All'];
  return settings.rules.filter((rule) => {
    if (!rule.enabled || !methodMatches(rule, method)) return false;
    if (!activeProfiles.includes('All') && rule.profiles?.length && !rule.profiles.some((profile) => activeProfiles.includes(profile))) return false;
    return urlMatches(rule.urlPattern, url);
  });
}

export function urlMatches(pattern: string, url: string): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, 'i').test(url);
  } catch {
    return url.toLowerCase().includes(pattern.toLowerCase());
  }
}

export function applyHeaders(headers: Headers, changes: HeaderMap | undefined): Headers {
  const output = new Headers(headers);
  for (const [name, value] of Object.entries(changes || {})) {
    if (value === '') output.delete(name);
    else output.set(name, value);
  }
  return output;
}

export function parseHeaderInput(value: string): HeaderMap {
  const output: HeaderMap = {};
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const index = line.indexOf(':');
    if (index === -1) throw new Error(`Invalid header: ${line}`);
    output[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return output;
}

export function formatHeaders(headers: HeaderMap | undefined): string {
  return Object.entries(headers || {}).map(([name, value]) => `${name}: ${value}`).join('\n');
}

export function applyJsonEdits(body: string, edits: JsonEdit[] | undefined): string {
  if (!edits?.length) return body;
  const document = JSON.parse(body);
  for (const edit of edits) setJsonPath(document, edit.path, parseJsonValue(edit.value));
  return JSON.stringify(document, null, 2);
}

export function parseJsonEdits(value: string): JsonEdit[] {
  if (!value.trim()) return [];
  return value.split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    if (index < 1) throw new Error(`Invalid JSON edit: ${line}`);
    return { path: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
  });
}

export function formatJsonEdits(edits: JsonEdit[] | undefined): string {
  return (edits || []).map((edit) => `${edit.path}=${edit.value}`).join('\n');
}

export function diagnoseRules(rules: Rule[]): RuleDiagnostic[] {
  const diagnostics: RuleDiagnostic[] = [];
  const signatures = new Map<string, string>();
  for (const rule of rules) {
    if (!rule.urlPattern) diagnostics.push({ ruleId: rule.id, severity: 'warning', message: 'Matches every URL' });
    else {
      try { new RegExp(rule.urlPattern); } catch { diagnostics.push({ ruleId: rule.id, severity: 'warning', message: 'Pattern is treated as plain text' }); }
    }
    if (rule.responseStatus && (rule.responseStatus < 100 || rule.responseStatus > 599)) diagnostics.push({ ruleId: rule.id, severity: 'error', message: 'Status must be between 100 and 599' });
    const signature = `${rule.method}|${rule.urlPattern}|${(rule.profiles || []).sort().join(',')}`;
    const duplicate = signatures.get(signature);
    if (duplicate) diagnostics.push({ ruleId: rule.id, severity: 'warning', message: 'Duplicates another rule matcher' });
    else signatures.set(signature, rule.id);
  }
  return diagnostics;
}

export function exportRules(settings: Settings): string {
  return JSON.stringify({ format: 'network-modifier', version: 1, settings }, null, 2);
}

export function importRules(value: string): Rule[] {
  const parsed = JSON.parse(value);
  if (Array.isArray(parsed)) return parsed.map(normalizeImportedRule);
  if (parsed?.format === 'network-modifier' && Array.isArray(parsed.settings?.rules)) return parsed.settings.rules.map(normalizeImportedRule);
  if (Array.isArray(parsed?.log?.entries)) return parsed.log.entries.map(harEntryToRule).filter((rule: Rule | null): rule is Rule => Boolean(rule));
  const requestlyRules = parsed?.rules || parsed?.items;
  if (Array.isArray(requestlyRules)) return requestlyRules.map(requestlyToRule).filter((rule): rule is Rule => Boolean(rule));
  throw new Error('Unsupported rule file');
}

function harEntryToRule(entry: Record<string, unknown>): Rule | null {
  const request = entry.request as Record<string, unknown> | undefined;
  const response = entry.response as Record<string, unknown> | undefined;
  const content = response?.content as Record<string, unknown> | undefined;
  if (!request?.url) return null;
  return normalizeImportedRule({
    name: `${String(request.method || '*')} ${new URL(String(request.url)).pathname}`,
    method: String(request.method || '*'),
    urlPattern: `^${escapeRegExp(String(request.url))}$`,
    responseStatus: Number(response?.status) || 0,
    responseBody: String(content?.text || ''),
    folder: 'HAR import'
  });
}

export function trafficToHar(records: TrafficRecord[]): string {
  return JSON.stringify({
    log: {
      version: '1.2',
      creator: { name: 'Network Modifier', version: '0.1.0' },
      entries: records.map((record) => ({
        startedDateTime: new Date(record.startedAt).toISOString(),
        time: record.duration,
        request: { method: record.method, url: record.url, httpVersion: 'HTTP/1.1', headers: headerEntries(record.requestHeaders), queryString: [], cookies: [], headersSize: -1, bodySize: record.requestBody.length, postData: record.requestBody ? { mimeType: record.requestHeaders['content-type'] || 'text/plain', text: record.requestBody } : undefined },
        response: { status: record.status, statusText: '', httpVersion: 'HTTP/1.1', headers: headerEntries(record.responseHeaders), cookies: [], content: { size: record.responseBody.length, mimeType: record.responseHeaders['content-type'] || 'text/plain', text: record.responseBody }, redirectURL: '', headersSize: -1, bodySize: record.responseBody.length },
        cache: {}, timings: { send: 0, wait: record.duration, receive: 0 }
      }))
    }
  }, null, 2);
}

export function lineDiff(before: string, after: string): string {
  const left = before.split('\n');
  const right = after.split('\n');
  const rows: string[] = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === right[index]) rows.push(`  ${left[index] ?? ''}`);
    else {
      if (left[index] !== undefined) rows.push(`- ${left[index]}`);
      if (right[index] !== undefined) rows.push(`+ ${right[index]}`);
    }
  }
  return rows.join('\n');
}

function methodMatches(rule: Rule, method: string): boolean {
  return !rule.method || rule.method === '*' || rule.method.toUpperCase() === method.toUpperCase();
}

function parseJsonValue(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function setJsonPath(document: unknown, path: string, value: unknown): void {
  const segments = path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  if (!segments.length || typeof document !== 'object' || document === null) throw new Error(`Invalid JSON path: ${path}`);
  let cursor = document as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== 'object' || next === null) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = value;
}

function normalizeImportedRule(value: Partial<Rule>): Rule {
  return {
    id: value.id || `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: value.name || 'Imported rule', enabled: value.enabled !== false, urlPattern: value.urlPattern || '', method: value.method || '*', delayMs: Number(value.delayMs) || 0,
    requestBody: value.requestBody || '', responseBody: value.responseBody || '', responseStatus: Number(value.responseStatus) || 0, error: Boolean(value.error),
    requestHeaders: value.requestHeaders, responseHeaders: value.responseHeaders, requestJsonEdits: value.requestJsonEdits, responseJsonEdits: value.responseJsonEdits,
    breakOnRequest: value.breakOnRequest, breakOnResponse: value.breakOnResponse, folder: value.folder, profiles: value.profiles
  };
}

function requestlyToRule(value: Record<string, unknown>): Rule | null {
  const pairs = (value.pairs || value.ruleType === 'Response' ? [value] : []) as Array<Record<string, unknown>>;
  const pair = pairs[0] || value;
  const source = (pair.source || {}) as Record<string, unknown>;
  const response = (pair.response || {}) as Record<string, unknown>;
  const urlPattern = String(source.value || source.url || value.url || '');
  if (!urlPattern) return null;
  return normalizeImportedRule({ name: String(value.name || 'Imported Requestly rule'), urlPattern, method: String(source.requestMethod || '*'), responseBody: String(response.value || pair.responseBody || '') });
}

function headerEntries(headers: HeaderMap) {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
