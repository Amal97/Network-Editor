import { DEFAULT_SETTINGS, Rule, Settings, TrafficRecord } from './types';

const tabId = chrome.devtools.inspectedWindow.tabId;
let settings: Settings = DEFAULT_SETTINGS;
let traffic: TrafficRecord[] = [];
let selectedId = '';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function initialize() {
  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  traffic = (await chrome.runtime.sendMessage({ type: 'get-traffic', tabId })).traffic || [];
  wire();
  render();
}

function wire() {
  byId<HTMLButtonElement>('clear').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clear-traffic', tabId });
    traffic = [];
    selectedId = '';
    renderTraffic();
  };
  byId<HTMLInputElement>('search').oninput = renderTraffic;
  byId<HTMLButtonElement>('newRule').onclick = () => editRule(newRule());
  byId<HTMLButtonElement>('pause').onclick = async () => {
    settings.enabled = !settings.enabled;
    await saveSettings();
  };
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'traffic' && message.record?.tabId === tabId) {
      traffic.push(message.record);
      renderTraffic();
    }
  });
}

function render() {
  byId<HTMLButtonElement>('pause').textContent = settings.enabled ? 'Pause' : 'Resume';
  renderTraffic();
  renderRules();
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
    row.innerHTML = `<span class="method">${escapeHtml(record.method)}</span><span class="status s-${String(record.status)[0]}" title="${modified ? 'Page-visible response modified' : 'Response status'}">${record.error ? 'ERR' : record.status}${modified ? '*' : ''}</span><span class="url">${escapeHtml(shortUrl(record.url))}</span><span class="time">${record.duration}ms</span>`;
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
  detail.innerHTML = `<div class="detail-head"><div><strong>${escapeHtml(record.method)} ${escapeHtml(record.url)}</strong><span>${escapeHtml(statusText)} · ${record.duration}ms</span></div><button id="createFromRequest" class="primary">Create rule</button></div>${record.ruleIds.length ? '<div class="modified-note">Modified responses are visible to page JavaScript. Chrome Network shows the original server exchange.</div>' : ''}${section('Request', record.requestHeaders, record.requestBody)}${section('Page-visible response', record.responseHeaders, record.responseBody)}${record.ruleIds.length ? `<p class="applied">Rules applied: ${record.ruleIds.length}</p>` : ''}`;
  byId<HTMLButtonElement>('createFromRequest').onclick = () => editRule(ruleFromTraffic(record));
}

function section(title: string, headers: Record<string, string>, body: string) {
  const headerText = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\n');
  return `<section><h3>${title}</h3><pre>${escapeHtml([headerText, body].filter(Boolean).join('\n\n') || 'Empty')}</pre></section>`;
}

function renderRules() {
  const list = byId('ruleList');
  list.innerHTML = '';
  for (const rule of settings.rules) {
    const row = document.createElement('article');
    row.className = `rule-row${rule.enabled ? '' : ' disabled'}`;
    row.innerHTML = `<label><input type="checkbox" ${rule.enabled ? 'checked' : ''}><span><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(rule.method || '*')} · ${escapeHtml(rule.urlPattern || 'all URLs')}</small></span></label><button>Edit</button>`;
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
  byId<HTMLButtonElement>('deleteRule').hidden = !settings.rules.some((item) => item.id === rule.id);
  byId<HTMLButtonElement>('saveRule').onclick = async () => {
    rule.name = byId<HTMLInputElement>('ruleName').value.trim() || 'Untitled rule';
    rule.method = byId<HTMLSelectElement>('ruleMethod').value;
    rule.urlPattern = byId<HTMLInputElement>('ruleUrl').value.trim();
    rule.delayMs = Number(byId<HTMLInputElement>('ruleDelay').value) || 0;
    rule.requestBody = byId<HTMLTextAreaElement>('requestBody').value;
    rule.responseBody = byId<HTMLTextAreaElement>('responseBody').value;
    rule.responseStatus = Number(byId<HTMLInputElement>('responseStatus').value) || 0;
    rule.error = byId<HTMLInputElement>('ruleError').checked;
    if (!settings.rules.some((item) => item.id === rule.id)) settings.rules.push(rule);
    await saveSettings();
    dialog.close();
  };
  byId<HTMLButtonElement>('deleteRule').onclick = async () => { settings.rules = settings.rules.filter((item) => item.id !== rule.id); await saveSettings(); dialog.close(); };
  byId<HTMLButtonElement>('cancelRule').onclick = () => dialog.close();
  dialog.showModal();
}

async function saveSettings() {
  await chrome.storage.local.set({ settings });
  await chrome.tabs.sendMessage(tabId, { type: 'settings-changed' }).catch(() => undefined);
  render();
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
initialize();
