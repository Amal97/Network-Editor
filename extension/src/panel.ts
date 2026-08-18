import { DEFAULT_NETWORK_CONDITIONS, DEFAULT_SETTINGS, Rule, Settings, TrafficRecord } from './types';
import { diagnoseRules, exportRules, formatHeaders, formatJsonEdits, importRules, lineDiff, NETWORK_PRESETS, parseHeaderInput, parseJsonEdits, RESPONSE_PRESETS, trafficToHar, urlMatches } from './rule-utils';
import { Activity, Braces, createIcons, Download, FileJson, GitCompareArrows, Pause, Play, Trash2, Upload } from 'lucide';

const tabId = chrome.devtools.inspectedWindow.tabId;
let settings: Settings = DEFAULT_SETTINGS;
let traffic: TrafficRecord[] = [];
let selectedId = '';
const comparisonIds = new Set<string>();

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function runtimeMessage<T = Record<string, unknown>>(message: unknown): Promise<T | undefined> {
  try {
    if (!chrome.runtime?.id) return undefined;
    return await chrome.runtime.sendMessage(message) as T;
  } catch {
    return undefined;
  }
}

function showConnectionError(): void {
  const status = byId('modeStatus');
  status.hidden = false;
  status.textContent = 'Extension context changed. Close DevTools, reload this page, then reopen DevTools.';
}

async function initialize() {
  try {
    const stored = await chrome.storage.local.get('settings');
    settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
    traffic = (await runtimeMessage<{ traffic?: TrafficRecord[] }>({ type: 'get-traffic', tabId }))?.traffic || [];
    wire();
    render();
    await synchronizeInterceptionMode();
  } catch {
    wire();
    render();
    showConnectionError();
  }
}

async function synchronizeInterceptionMode(): Promise<void> {
  const fullModeEnabled = settings.enabled && settings.interceptionMode === 'full';
  const result = await runtimeMessage<{ ok: boolean; error?: string }>({
    type: 'configure-full-mode',
    tabId,
    enabled: fullModeEnabled
  });
  if (!result) {
    showConnectionError();
    return;
  }
  if (!result.ok) {
    const status = byId('modeStatus');
    status.hidden = false;
    status.textContent = result.error || 'Could not activate Full mode.';
  }
}

function wire() {
  byId<HTMLButtonElement>('clear').onclick = async () => {
    await runtimeMessage({ type: 'clear-traffic', tabId });
    traffic = [];
    selectedId = '';
    renderTraffic();
  };
  byId<HTMLInputElement>('search').oninput = renderTraffic;
  byId<HTMLButtonElement>('newRule').onclick = () => editRule(newRule());
  byId<HTMLSelectElement>('mode').onchange = changeMode;
  byId<HTMLSelectElement>('profile').onchange = async (event) => {
    settings.activeProfiles = [(event.target as HTMLSelectElement).value];
    await saveSettings();
  };
  byId<HTMLButtonElement>('network').onclick = showNetworkDialog;
  byId<HTMLButtonElement>('compare').onclick = showComparison;
  byId<HTMLButtonElement>('exportRules').onclick = () => download('network-modifier-rules.json', exportRules(settings));
  byId<HTMLButtonElement>('exportHar').onclick = () => download('network-modifier-traffic.har', trafficToHar(traffic));
  byId<HTMLButtonElement>('importRules').onclick = () => byId<HTMLInputElement>('ruleFile').click();
  byId<HTMLInputElement>('ruleFile').onchange = importRuleFile;
  byId<HTMLButtonElement>('pause').onclick = async () => {
    settings.enabled = !settings.enabled;
    await saveSettings();
  };
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'traffic' && message.record?.tabId === tabId) {
      traffic.push(message.record);
      renderTraffic();
    }
    if (message?.type === 'breakpoints-changed' && message.tabId === tabId) renderBreakpoints();
  });
}

function render() {
  const pause = byId<HTMLButtonElement>('pause');
  const pauseLabel = settings.enabled ? 'Pause interception' : 'Resume interception';
  pause.title = pauseLabel;
  pause.setAttribute('aria-label', pauseLabel);
  pause.innerHTML = `<i data-lucide="${settings.enabled ? 'pause' : 'play'}"></i>`;
  byId<HTMLSelectElement>('mode').value = settings.interceptionMode || 'page';
  renderModeStatus();
  renderProfiles();
  renderTraffic();
  renderRules();
  renderBreakpoints();
  createIcons({ icons: { Activity, Braces, Download, FileJson, GitCompareArrows, Pause, Play, Trash2, Upload } });
}

function renderTraffic() {
  const list = byId<HTMLElement>('trafficList');
  const query = byId<HTMLInputElement>('search').value.toLowerCase();
  list.innerHTML = '';
  const visible = traffic.filter((record) => `${record.method} ${record.url} ${record.status}`.toLowerCase().includes(query));
  byId('count').textContent = `${visible.length} requests`;
  for (const record of [...visible].reverse()) {
    const row = document.createElement('button');
    row.className = `traffic-row${record.id === selectedId ? ' selected' : ''}`;
    const modified = record.ruleIds.length > 0 && (record.status !== record.originalStatus || Boolean(record.responseBody));
    row.innerHTML = `<input class="compare-check" type="checkbox" title="Select for comparison" ${comparisonIds.has(record.id) ? 'checked' : ''}><span class="method">${escapeHtml(record.method)}</span><span class="status s-${String(record.status)[0]}" title="${modified ? 'Response modified' : 'Response status'}">${record.error ? 'ERR' : record.status}${modified ? '*' : ''}</span><span class="url">${escapeHtml(shortUrl(record.url))}</span><span class="time">${record.duration}ms</span>`;
    row.querySelector<HTMLInputElement>('input')!.onclick = (event) => {
      event.stopPropagation();
      if ((event.target as HTMLInputElement).checked) comparisonIds.add(record.id); else comparisonIds.delete(record.id);
      if (comparisonIds.size > 2) comparisonIds.delete(comparisonIds.values().next().value!);
      renderTraffic();
    };
    row.onclick = () => { selectedId = record.id; renderTraffic(); renderDetail(record); };
    list.append(row);
  }
  if (!visible.length) list.innerHTML = '<div class="empty">Reload the inspected page to capture XHR and Fetch traffic.</div>';
}

function renderDetail(record: TrafficRecord) {
  const detail = byId('detail');
  const statusText = record.originalStatus !== undefined && record.originalStatus !== record.status
    ? `Server ${record.originalStatus} → page sees ${record.status}`
    : `Status ${record.status || record.error || ''}`;
  const modeNote = settings.interceptionMode === 'full'
    ? 'Full mode modified this request at the Chrome network response stage.'
    : 'Page mode modifications are visible to page JavaScript; Chrome Network shows the server exchange.';
  detail.innerHTML = `<div class="detail-head"><div><strong>${escapeHtml(record.method)} ${escapeHtml(record.url)}</strong><span>${escapeHtml(statusText)} · ${record.duration}ms</span></div><div><button id="copyResponse">Copy response</button><button id="createFromRequest" class="primary">Create rule</button></div></div>${record.ruleIds.length ? `<div class="modified-note">${escapeHtml(modeNote)}</div>` : ''}${section('Request', record.requestHeaders, record.requestBody)}${section('Modified response', record.responseHeaders, record.responseBody)}${record.ruleIds.length ? `<p class="applied">Rules applied: ${record.ruleIds.length}</p>` : ''}`;
  byId<HTMLButtonElement>('createFromRequest').onclick = () => editRule(ruleFromTraffic(record));
  byId<HTMLButtonElement>('copyResponse').onclick = async (event) => {
    await navigator.clipboard.writeText(record.responseBody);
    (event.currentTarget as HTMLButtonElement).textContent = 'Copied';
  };
}

function renderModeStatus(): void {
  const status = byId('modeStatus');
  status.hidden = true;
  status.textContent = '';
}

function section(title: string, headers: Record<string, string>, body: string) {
  const headerText = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\n');
  return `<section><h3>${title}</h3><pre>${escapeHtml([headerText, body].filter(Boolean).join('\n\n') || 'Empty')}</pre></section>`;
}

function renderRules() {
  const list = byId('ruleList');
  list.innerHTML = '';
  const diagnostics = diagnoseRules(settings.rules);
  let currentFolder = '';
  for (const rule of [...settings.rules].sort((left, right) => (left.folder || 'Default').localeCompare(right.folder || 'Default'))) {
    const folder = rule.folder || 'Default';
    if (folder !== currentFolder) {
      currentFolder = folder;
      list.insertAdjacentHTML('beforeend', `<div class="folder-head">${escapeHtml(folder)}</div>`);
    }
    const row = document.createElement('article');
    row.className = `rule-row${rule.enabled ? '' : ' disabled'}`;
    const warnings = diagnostics.filter((item) => item.ruleId === rule.id);
    const hits = traffic.filter((record) => record.ruleIds.includes(rule.id)).length;
    if (!hits && traffic.length) warnings.push({ ruleId: rule.id, severity: 'warning', message: 'No matches in current traffic' });
    row.innerHTML = `<label><input type="checkbox" ${rule.enabled ? 'checked' : ''}><span><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(rule.method || '*')} · ${escapeHtml(rule.urlPattern || 'all URLs')}</small><small>${hits} hit${hits === 1 ? '' : 's'}${warnings.length ? ` · <span class="warning" title="${escapeHtml(warnings.map((item) => item.message).join('; '))}">${warnings.length} warning${warnings.length === 1 ? '' : 's'}</span>` : ''}</small></span></label><button>Edit</button>`;
    row.querySelector<HTMLInputElement>('input')!.onchange = async (event) => { rule.enabled = (event.target as HTMLInputElement).checked; await saveSettings(); };
    row.querySelector<HTMLButtonElement>('button')!.onclick = () => editRule(rule);
    list.append(row);
  }
  if (!settings.rules.length) list.innerHTML = '<div class="empty compact">No rules yet. Create one to modify an API call.</div>';
}

function editRule(rule: Rule) {
  const dialog = byId<HTMLDialogElement>('ruleDialog');
  byId<HTMLInputElement>('ruleName').value = rule.name;
  byId<HTMLSelectElement>('ruleMethod').value = rule.method;
  byId<HTMLInputElement>('ruleUrl').value = rule.urlPattern;
  byId<HTMLInputElement>('ruleDelay').value = String(rule.delayMs || 0);
  byId<HTMLTextAreaElement>('requestBody').value = rule.requestBody;
  byId<HTMLTextAreaElement>('responseBody').value = rule.responseBody;
  byId<HTMLInputElement>('responseStatus').value = String(rule.responseStatus || 0);
  byId<HTMLInputElement>('ruleError').checked = rule.error;
  byId<HTMLInputElement>('ruleFolder').value = rule.folder || '';
  byId<HTMLInputElement>('ruleProfiles').value = (rule.profiles || []).join(', ');
  byId<HTMLTextAreaElement>('requestHeaders').value = formatHeaders(rule.requestHeaders);
  byId<HTMLTextAreaElement>('responseHeaders').value = formatHeaders(rule.responseHeaders);
  byId<HTMLTextAreaElement>('requestJsonEdits').value = formatJsonEdits(rule.requestJsonEdits);
  byId<HTMLTextAreaElement>('responseJsonEdits').value = formatJsonEdits(rule.responseJsonEdits);
  byId<HTMLInputElement>('breakRequest').checked = Boolean(rule.breakOnRequest);
  byId<HTMLInputElement>('breakResponse').checked = Boolean(rule.breakOnResponse);
  populatePresets();
  updateMatchPreview();
  byId<HTMLInputElement>('ruleUrl').oninput = updateMatchPreview;
  byId<HTMLButtonElement>('formatRequestBody').onclick = () => formatJsonBody('requestBody');
  byId<HTMLButtonElement>('formatResponseBody').onclick = () => formatJsonBody('responseBody');
  clearBodyFormatError('requestBody');
  clearBodyFormatError('responseBody');
  byId<HTMLButtonElement>('deleteRule').hidden = !settings.rules.some((item) => item.id === rule.id);
  byId<HTMLButtonElement>('saveRule').onclick = async () => {
    try {
    rule.name = byId<HTMLInputElement>('ruleName').value.trim() || 'Untitled rule';
    rule.method = byId<HTMLSelectElement>('ruleMethod').value;
    rule.urlPattern = byId<HTMLInputElement>('ruleUrl').value.trim();
    rule.delayMs = Number(byId<HTMLInputElement>('ruleDelay').value) || 0;
    rule.requestBody = byId<HTMLTextAreaElement>('requestBody').value;
    rule.responseBody = byId<HTMLTextAreaElement>('responseBody').value;
    rule.responseStatus = Number(byId<HTMLInputElement>('responseStatus').value) || 0;
    rule.error = byId<HTMLInputElement>('ruleError').checked;
    rule.folder = byId<HTMLInputElement>('ruleFolder').value.trim() || 'Default';
    rule.profiles = byId<HTMLInputElement>('ruleProfiles').value.split(',').map((value) => value.trim()).filter(Boolean);
    rule.requestHeaders = parseHeaderInput(byId<HTMLTextAreaElement>('requestHeaders').value);
    rule.responseHeaders = parseHeaderInput(byId<HTMLTextAreaElement>('responseHeaders').value);
    rule.requestJsonEdits = parseJsonEdits(byId<HTMLTextAreaElement>('requestJsonEdits').value);
    rule.responseJsonEdits = parseJsonEdits(byId<HTMLTextAreaElement>('responseJsonEdits').value);
    rule.breakOnRequest = byId<HTMLInputElement>('breakRequest').checked;
    rule.breakOnResponse = byId<HTMLInputElement>('breakResponse').checked;
    if (!settings.rules.some((item) => item.id === rule.id)) settings.rules.push(rule);
    await saveSettings();
    dialog.close();
    } catch (error) {
      byId('matchPreview').textContent = error instanceof Error ? error.message : String(error);
      byId('matchPreview').className = 'match-preview error';
    }
  };
  byId<HTMLButtonElement>('deleteRule').onclick = async () => { settings.rules = settings.rules.filter((item) => item.id !== rule.id); await saveSettings(); dialog.close(); };
  byId<HTMLButtonElement>('cancelRule').onclick = () => dialog.close();
  dialog.showModal();
}

function formatJsonBody(id: 'requestBody' | 'responseBody'): void {
  const textarea = byId<HTMLTextAreaElement>(id);
  const error = byId<HTMLElement>(`${id}Error`);
  try {
    textarea.value = JSON.stringify(JSON.parse(textarea.value), null, 2);
    error.hidden = true;
    error.textContent = '';
  } catch (cause) {
    error.hidden = false;
    error.textContent = cause instanceof Error ? cause.message : 'Invalid JSON';
  }
}

function clearBodyFormatError(id: 'requestBody' | 'responseBody'): void {
  const error = byId<HTMLElement>(`${id}Error`);
  error.hidden = true;
  error.textContent = '';
}

async function saveSettings() {
  await chrome.storage.local.set({ settings });
  await chrome.tabs.sendMessage(tabId, { type: 'settings-changed' }).catch(() => undefined);
  if (settings.interceptionMode === 'full') await runtimeMessage({ type: 'configure-full-mode', tabId, enabled: settings.enabled });
  render();
}

async function changeMode(event: Event) {
  const mode = (event.target as HTMLSelectElement).value as 'page' | 'full';
  const result = await runtimeMessage<{ ok: boolean; error?: string }>({ type: 'configure-full-mode', tabId, enabled: mode === 'full' });
  const status = byId('modeStatus');
  if (!result) { showConnectionError(); return; }
  status.hidden = result.ok;
  status.textContent = result.error || '';
  if (!result.ok) {
    byId<HTMLSelectElement>('mode').value = settings.interceptionMode || 'page';
    return;
  }
  settings.interceptionMode = mode;
  await saveSettings();
}

function renderProfiles() {
  const select = byId<HTMLSelectElement>('profile');
  const profiles = new Set(['All', ...settings.rules.flatMap((rule) => rule.profiles || [])]);
  select.innerHTML = [...profiles].map((profile) => `<option>${escapeHtml(profile)}</option>`).join('');
  select.value = settings.activeProfiles?.[0] || 'All';
}

function updateMatchPreview() {
  const pattern = byId<HTMLInputElement>('ruleUrl').value;
  const matches = traffic.filter((record) => urlMatches(pattern, record.url)).length;
  byId('matchPreview').className = 'match-preview';
  byId('matchPreview').textContent = `Matches ${matches} captured request${matches === 1 ? '' : 's'}`;
}

function populatePresets() {
  const select = byId<HTMLSelectElement>('responsePreset');
  select.innerHTML = '<option value="">Custom</option>' + RESPONSE_PRESETS.map((preset) => `<option value="${preset.status}">${preset.status} ${escapeHtml(preset.name)}</option>`).join('');
  select.onchange = () => {
    const preset = RESPONSE_PRESETS.find((item) => item.status === Number(select.value));
    if (!preset) return;
    byId<HTMLInputElement>('responseStatus').value = String(preset.status);
    byId<HTMLTextAreaElement>('responseBody').value = preset.body;
  };
}

async function renderBreakpoints() {
  const container = byId('breakpoints');
  const response = await runtimeMessage<{ breakpoints?: Array<{ id: string; stage: string; method: string; url: string }> }>({ type: 'get-breakpoints', tabId });
  const breakpoints = response?.breakpoints || [];
  container.hidden = !breakpoints.length;
  container.innerHTML = breakpoints.map((item: { id: string; stage: string; method: string; url: string }) => `<span>Paused ${escapeHtml(item.stage)}: ${escapeHtml(item.method)} ${escapeHtml(shortUrl(item.url))}</span><button data-id="${escapeHtml(item.id)}">Continue</button>`).join('');
  container.querySelectorAll<HTMLButtonElement>('button').forEach((button) => button.onclick = async () => {
    await runtimeMessage({ type: 'continue-breakpoint', id: button.dataset.id });
    renderBreakpoints();
  });
}

function showNetworkDialog() {
  const dialog = byId<HTMLDialogElement>('networkDialog');
  const conditions = settings.networkConditions || DEFAULT_NETWORK_CONDITIONS;
  const preset = byId<HTMLSelectElement>('networkPreset');
  preset.innerHTML = Object.keys(NETWORK_PRESETS).map((name) => `<option>${name}</option>`).join('') + '<option>Custom</option>';
  const fill = () => {
    byId<HTMLInputElement>('latency').value = String(conditions.latencyMs);
    byId<HTMLInputElement>('failureRate').value = String(conditions.failureRate * 100);
    byId<HTMLInputElement>('downloadKbps').value = String(conditions.downloadKbps);
    byId<HTMLInputElement>('uploadKbps').value = String(conditions.uploadKbps);
    byId<HTMLInputElement>('offline').checked = conditions.offline;
  };
  fill();
  preset.onchange = () => {
    const value = NETWORK_PRESETS[preset.value as keyof typeof NETWORK_PRESETS];
    if (value) Object.assign(conditions, value);
    fill();
  };
  byId<HTMLButtonElement>('cancelNetwork').onclick = () => dialog.close();
  byId<HTMLButtonElement>('saveNetwork').onclick = async () => {
    settings.networkConditions = { offline: byId<HTMLInputElement>('offline').checked, latencyMs: Number(byId<HTMLInputElement>('latency').value) || 0, failureRate: (Number(byId<HTMLInputElement>('failureRate').value) || 0) / 100, downloadKbps: Number(byId<HTMLInputElement>('downloadKbps').value) || 0, uploadKbps: Number(byId<HTMLInputElement>('uploadKbps').value) || 0 };
    await saveSettings(); dialog.close();
  };
  dialog.showModal();
}

function showComparison() {
  const records = [...comparisonIds].map((id) => traffic.find((record) => record.id === id)).filter((record): record is TrafficRecord => Boolean(record));
  if (records.length !== 2) { byId('modeStatus').hidden = false; byId('modeStatus').textContent = 'Select exactly two traffic checkboxes to compare.'; return; }
  byId('comparison').textContent = `--- ${records[0].method} ${records[0].url}\n+++ ${records[1].method} ${records[1].url}\n${lineDiff(records[0].responseBody, records[1].responseBody)}`;
  const dialog = byId<HTMLDialogElement>('compareDialog');
  byId<HTMLButtonElement>('closeCompare').onclick = () => dialog.close();
  dialog.showModal();
}

async function importRuleFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try { settings.rules.push(...importRules(await file.text())); await saveSettings(); }
  catch (error) { byId('modeStatus').hidden = false; byId('modeStatus').textContent = error instanceof Error ? error.message : String(error); }
  (event.target as HTMLInputElement).value = '';
}

function download(filename: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function newRule(): Rule {
  return { id: `r${Date.now().toString(36)}`, name: 'New API rule', enabled: true, urlPattern: '', method: '*', delayMs: 0, requestBody: '', responseBody: '', responseStatus: 0, error: false };
}

function ruleFromTraffic(record: TrafficRecord): Rule {
  const url = new URL(record.url);
  return {
    ...newRule(),
    name: `${record.method} ${url.pathname}`,
    method: record.method,
    urlPattern: `^${escapeRegExp(record.url)}$`,
    requestBody: record.requestBody,
    responseBody: record.responseBody,
    responseStatus: record.status
  };
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function shortUrl(value: string) { try { const url = new URL(value); return `${url.host}${url.pathname}${url.search}`; } catch { return value; } }
function escapeHtml(value: unknown) { return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
initialize().catch(showConnectionError);
