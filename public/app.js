/* Network Modifier - web UI */
'use strict';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BODY_TYPES = ['text', 'json', 'base64', 'form', 'file'];

const ACTION_FIELDS = {
  redirect: [{ k: 'url', label: 'Target URL', type: 'text', ph: 'https://127.0.0.1:3000{{pathAndQuery}}' }],
  'set-method': [{ k: 'method', label: 'Method', type: 'select', options: METHODS }],
  'set-request-header': [{ k: 'name', label: 'Header', type: 'text', ph: 'Authorization' }, { k: 'value', label: 'Value', type: 'text' }],
  'add-request-header': [{ k: 'name', label: 'Header', type: 'text' }, { k: 'value', label: 'Value', type: 'text' }],
  'remove-request-header': [{ k: 'name', label: 'Header', type: 'text', ph: 'cookie' }],
  'set-request-body': [
    { k: 'bodyType', label: 'Body type', type: 'select', options: BODY_TYPES },
    { k: 'value', label: 'Body / file path', type: 'textarea' },
    { k: 'contentType', label: 'Content-Type override', type: 'text' }
  ],
  'set-query-param': [{ k: 'name', label: 'Name', type: 'text' }, { k: 'value', label: 'Value', type: 'text' }],
  'remove-query-param': [{ k: 'name', label: 'Name', type: 'text' }],
  'mock-response': [
    { k: 'status', label: 'Status', type: 'number', ph: '200' },
    { k: 'bodyType', label: 'Body type', type: 'select', options: BODY_TYPES },
    { k: 'value', label: 'Body / file path', type: 'textarea' },
    { k: 'contentType', label: 'Content-Type', type: 'text' }
  ],
  'map-local': [
    { k: 'path', label: 'Local file path', type: 'text', ph: '/Users/me/dev/app.js' },
    { k: 'contentType', label: 'Content-Type override', type: 'text' }
  ],
  cancel: [{ k: 'reason', label: 'Reason (shown in the list)', type: 'text' }],
  'delay-request': [{ k: 'ms', label: 'Delay (ms)', type: 'number', ph: '1000' }],
  'delay-response': [{ k: 'ms', label: 'Delay (ms)', type: 'number', ph: '1000' }],
  'breakpoint-request': [],
  'breakpoint-response': [],
  'set-status': [{ k: 'status', label: 'Status code', type: 'number', ph: '500' }, { k: 'statusMessage', label: 'Status text', type: 'text' }],
  'set-response-header': [{ k: 'name', label: 'Header', type: 'text' }, { k: 'value', label: 'Value', type: 'text' }],
  'add-response-header': [{ k: 'name', label: 'Header', type: 'text' }, { k: 'value', label: 'Value', type: 'text' }],
  'remove-response-header': [{ k: 'name', label: 'Header', type: 'text' }],
  'set-response-body': [
    { k: 'bodyType', label: 'Body type', type: 'select', options: BODY_TYPES },
    { k: 'value', label: 'Body / file path', type: 'textarea' },
    { k: 'contentType', label: 'Content-Type override', type: 'text' }
  ],
  cors: [{ k: 'origin', label: 'Allowed origin (blank = echo request origin)', type: 'text' }],
  throttle: [{ k: 'bytesPerSecond', label: 'Bytes per second', type: 'number', ph: '51200' }],
  script: [{ k: 'code', label: 'Script', type: 'code' }]
};

const ACTION_HELP = {
  redirect: 'Send the request to a different URL',
  'set-method': 'Change GET to POST, etc.',
  'set-request-header': 'Replace or add a header',
  'add-request-header': 'Append another value',
  'remove-request-header': 'Strip a header before sending',
  'set-request-body': 'Replace the outgoing payload',
  'set-query-param': 'Add or overwrite a ?param',
  'remove-query-param': 'Strip a ?param',
  'mock-response': 'Answer instantly without hitting the network',
  'map-local': 'Serve a file from disk instead',
  cancel: 'Block the request — the page sees a network error',
  'delay-request': 'Wait before sending upstream',
  'breakpoint-request': 'Pause so you can edit it by hand',
  'set-status': 'Force a different status code',
  'set-response-header': 'Replace or add a header',
  'add-response-header': 'Append another value',
  'remove-response-header': 'Strip a header before it reaches the page',
  'set-response-body': 'Replace what the page receives',
  'delay-response': 'Simulate a slow server',
  'breakpoint-response': 'Pause so you can edit it by hand',
  cors: 'Add permissive CORS headers',
  throttle: 'Limit bandwidth',
  script: 'Full programmatic control'
};

const SCRIPT_TEMPLATE = `// Runs for every matching request and response.
// ctx.phase is "request" or "response".
if (ctx.phase === 'request') {
  ctx.request.setHeader('X-Netmod', '1');
  // ctx.request.redirect('https://127.0.0.1:3000' + new URL(ctx.request.url).pathname);
  // ctx.cancel('blocked');
  // ctx.mock({ status: 200, body: { hello: 'world' } });
} else {
  // const data = ctx.response.json;
  // if (data) { data.injected = true; ctx.response.json = data; }
  // ctx.response.status = 503;
  // ctx.delay(500);
}`;

const state = {
  settings: {},
  proxy: {},
  ca: {},
  instructions: {},
  resourceTypes: [],
  rules: [],
  flows: new Map(),
  rows: new Map(),
  pickedFlows: new Set(),
  pickedRules: new Set(),
  selectedId: null,
  selectedRuleId: null,
  draft: null,
  dirty: false,
  detailTab: 'overview',
  pending: [],
  searchIds: null,
  searchTimer: null,
  searchVersion: 0,
  lastSeq: 0,
  version: ''
};

const el = (id) => document.getElementById(id);
const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = !!value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
};

/* --------------------------------------------------------------------- api */

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function toast(message, isError) {
  const node = h('div', { class: `toast${isError ? ' error' : ''}` }, message);
  document.body.appendChild(node);
  setTimeout(() => node.remove(), isError ? 5200 : 2600);
}

function formatBytes(n) {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let value = n;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${i === 0 ? value : value.toFixed(1)}${units[i]}`;
}

function formatMs(ms) {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/* ------------------------------------------------------------------ startup */

async function init() {
  const data = await api('/api/state');
  Object.assign(state, {
    settings: data.settings,
    proxy: data.proxy,
    ca: data.ca,
    instructions: data.instructions,
    resourceTypes: data.resourceTypes,
    rules: data.rules,
    pending: data.breakpoints,
    version: data.version
  });

  el('proxyAddress').textContent = `proxy ${data.proxy.host}:${data.proxy.port}  ·  v${data.version}`;
  for (const type of state.resourceTypes) {
    el('typeFilter').appendChild(h('option', { value: type }, type));
  }

  wireChrome();
  renderRules();
  renderSettings();
  renderHelp();
  renderBreakpointBar();
  syncToggles();

  const existing = await api('/api/flows');
  for (const flow of existing.flows) upsertFlow(flow);
  connectEvents();
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => el('connDot').classList.add('live'));
  source.addEventListener('error', () => el('connDot').classList.remove('live'));
  source.addEventListener('batch', (event) => {
    for (const item of JSON.parse(event.data)) handleEvent(item.event, item.data);
  });
}

function handleEvent(event, data) {
  switch (event) {
    case 'flow':
    case 'flow-update':
      upsertFlow(data);
      if (data.id === state.selectedId && (data.state === 'completed' || data.state === 'error')) {
        openDetail(data.id, true);
      }
      break;
    case 'cleared':
      state.flows.clear();
      state.rows.clear();
      state.pickedFlows.clear();
      el('flowBody').innerHTML = '';
      state.selectedId = null;
      el('detail').innerHTML = '';
      el('detail').appendChild(h('div', { class: 'empty' }, h('p', { class: 'muted' }, 'Select a request to inspect it.')));
      renderFlowBulk();
      updateCounter();
      break;
    case 'flows-removed':
      removeFlows(data);
      break;
    case 'breakpoints':
      state.pending = data;
      renderBreakpointBar();
      break;
    case 'rules':
      state.rules = data;
      renderRules();
      break;
    case 'settings':
      state.settings = data;
      syncToggles();
      renderRuleList();
      renderSettings();
      break;
    case 'log':
      if (data.level === 'error') console.warn('[netmod]', data.message || data.args);
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------- chrome */

function wireChrome() {
  el('mainTabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    for (const node of document.querySelectorAll('.tab')) node.classList.toggle('active', node === tab);
    for (const view of document.querySelectorAll('.view')) {
      view.classList.toggle('active', view.id === `view-${tab.dataset.view}`);
    }
  });

  el('recordToggle').addEventListener('click', () => patchSettings({ recording: !state.settings.recording }));
  el('connectBtn').addEventListener('click', openConnectDialog);
  el('bpRequest').addEventListener('click', () => patchSettings({
    breakpointsEnabled: true,
    breakpoints: { ...state.settings.breakpoints, onRequest: !state.settings.breakpoints.onRequest }
  }));
  el('bpResponse').addEventListener('click', () => patchSettings({
    breakpointsEnabled: true,
    breakpoints: { ...state.settings.breakpoints, onResponse: !state.settings.breakpoints.onResponse }
  }));
  el('clearFlows').addEventListener('click', () => api('/api/flows', { method: 'DELETE' }));
  el('quickFilter').addEventListener('input', scheduleFlowSearch);
  el('sourceFilter').addEventListener('change', applySourceFilter);
  el('typeFilter').addEventListener('change', applyFilter);
  el('statusFilter').addEventListener('change', applyFilter);
  el('exportHar').addEventListener('click', exportHar);

  el('flowSelectAll').addEventListener('change', (event) => {
    state.pickedFlows.clear();
    if (event.target.checked) {
      for (const [id, row] of state.rows) if (row.style.display !== 'none') state.pickedFlows.add(id);
    }
    for (const [id, row] of state.rows) {
      row.classList.toggle('picked', state.pickedFlows.has(id));
      row.querySelector('input[type=checkbox]').checked = state.pickedFlows.has(id);
    }
    renderFlowBulk();
  });
  el('flowBulkClear').addEventListener('click', clearFlowSelection);
  el('flowDelete').addEventListener('click', deleteSelectedFlows);

  el('addRule').addEventListener('click', createRule);
  el('exportRules').addEventListener('click', exportRules);
  el('importRules').addEventListener('click', importRules);
  el('ruleSearch').addEventListener('input', renderRuleList);
  el('ruleProfile').addEventListener('change', (event) => activateRuleProfile(event.target.value));
  wireRuleResizer();
  el('ruleSelectAll').addEventListener('change', (event) => {
    state.pickedRules = event.target.checked ? new Set(visibleRules().map((r) => r.id)) : new Set();
    renderRuleList();
  });
  el('ruleEnable').addEventListener('click', () => bulkRules('/api/rules/toggle', { enabled: true }));
  el('ruleDisable').addEventListener('click', () => bulkRules('/api/rules/toggle', { enabled: false }));
  el('ruleDuplicate').addEventListener('click', () => bulkRules('/api/rules/duplicate', {}));
  el('ruleDelete').addEventListener('click', deleteSelectedRules);

  el('resumeAll').addEventListener('click', () => api('/api/breakpoints/resume-all', { method: 'POST' }));
  el('openBreakpoint').addEventListener('click', () => {
    if (state.pending[0]) openBreakpointEditor(state.pending[0].id);
  });
  el('modalBackdrop').addEventListener('click', (event) => {
    if (event.target === el('modalBackdrop')) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && state.draft) {
      event.preventDefault();
      saveDraft();
    }
  });
}

function syncToggles() {
  el('recordToggle').classList.toggle('on', !!state.settings.recording);
  el('recordToggle').textContent = state.settings.recording ? 'Recording' : 'Paused';
  const bp = state.settings.breakpoints || {};
  el('bpRequest').classList.toggle('on', !!bp.onRequest);
  el('bpResponse').classList.toggle('on', !!bp.onResponse);
}

async function patchSettings(patch) {
  try {
    const data = await api('/api/settings', { method: 'PATCH', body: { settings: patch } });
    state.settings = data.settings;
    syncToggles();
    renderRuleList();
    renderSettings();
  } catch (err) {
    toast(err.message, true);
  }
}

async function activateRuleProfile(profile) {
  state.settings.activeRuleProfiles = [profile || '*'];
  renderRuleList();
  await patchSettings({ activeRuleProfiles: state.settings.activeRuleProfiles });
  renderRuleList();
}

function wireRuleResizer() {
  const layout = document.querySelector('.rules-layout');
  const resizer = el('ruleResizer');
  const saved = Number(localStorage.getItem('netmod-rule-sidebar-width'));
  if (saved) setRuleSidebarWidth(saved);

  const resize = (clientX) => {
    const bounds = layout.getBoundingClientRect();
    setRuleSidebarWidth(clientX - bounds.left);
  };
  resizer.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-rules');
  });
  resizer.addEventListener('pointermove', (event) => {
    if (resizer.hasPointerCapture(event.pointerId)) resize(event.clientX);
  });
  const finish = (event) => {
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    resizer.releasePointerCapture(event.pointerId);
    document.body.classList.remove('resizing-rules');
    localStorage.setItem('netmod-rule-sidebar-width', String(document.querySelector('.rule-sidebar').getBoundingClientRect().width));
  };
  resizer.addEventListener('pointerup', finish);
  resizer.addEventListener('pointercancel', finish);
  resizer.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const width = document.querySelector('.rule-sidebar').getBoundingClientRect().width;
    setRuleSidebarWidth(width + (event.key === 'ArrowRight' ? 20 : -20));
    localStorage.setItem('netmod-rule-sidebar-width', String(document.querySelector('.rule-sidebar').getBoundingClientRect().width));
  });
}

function setRuleSidebarWidth(width) {
  const layout = document.querySelector('.rules-layout');
  const available = layout.getBoundingClientRect().width || document.querySelector('main').getBoundingClientRect().width;
  const maximum = Math.max(280, available - 320);
  layout.style.setProperty('--rule-sidebar-width', `${Math.round(Math.min(maximum, Math.max(260, width)))}px`);
}

/* --------------------------------------------------------------- flow table */

function upsertFlow(flow) {
  const existing = state.flows.get(flow.id);
  state.flows.set(flow.id, flow);
  let row = state.rows.get(flow.id);
  const body = el('flowBody');
  const scroller = body.parentElement.parentElement;
  const nearBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 60;

  if (!row) {
    row = h('tr', { 'data-id': flow.id, onclick: () => openDetail(flow.id) });
    const pick = h('td', { class: 'pick' },
      h('input', {
        type: 'checkbox',
        onclick: (event) => {
          event.stopPropagation();
          toggleFlowPick(flow.id, event.target.checked);
        }
      }));
    row.appendChild(pick);
    for (let i = 0; i < 6; i++) row.appendChild(h('td'));
    row.children[3].className = 'url';
    body.appendChild(row);
    state.rows.set(flow.id, row);
  }
  paintRow(row, flow);
  row.style.display = matchesFilter(flow) ? '' : 'none';
  if (!existing && nearBottom) scroller.scrollTop = scroller.scrollHeight;
  updateCounter();
}

function paintRow(row, flow) {
  const cells = row.children;
  cells[1].innerHTML = '';
  cells[1].appendChild(h('span', { class: `method m-${flow.method}` }, flow.method));
  cells[2].innerHTML = '';
  cells[2].appendChild(statusNode(flow));
  cells[3].innerHTML = '';
  if (flow.scheme === 'https') cells[3].appendChild(h('span', { class: 'muted', title: 'https' }, '🔒 '));
  cells[3].appendChild(h('span', { title: flow.url }, flow.url.replace(/^https?:\/\//, '')));
  for (const badge of badges(flow)) cells[3].appendChild(badge);
  cells[4].textContent = flow.resourceType;
  cells[5].textContent = formatBytes(flow.responseSize);
  cells[6].textContent = formatMs(flow.duration);
  row.classList.toggle('selected', flow.id === state.selectedId);
  row.classList.toggle('picked', state.pickedFlows.has(flow.id));
}

function toggleFlowPick(id, picked) {
  if (picked) state.pickedFlows.add(id);
  else state.pickedFlows.delete(id);
  const row = state.rows.get(id);
  if (row) row.classList.toggle('picked', picked);
  renderFlowBulk();
}

function renderFlowBulk() {
  const count = state.pickedFlows.size;
  el('flowBulk').hidden = count === 0;
  el('flowBulkCount').textContent = `${count} selected`;
  if (!count) el('flowSelectAll').checked = false;
}

function clearFlowSelection() {
  state.pickedFlows.clear();
  el('flowSelectAll').checked = false;
  for (const row of state.rows.values()) {
    row.classList.remove('picked');
    row.querySelector('input[type=checkbox]').checked = false;
  }
  renderFlowBulk();
}

async function deleteSelectedFlows() {
  const ids = [...state.pickedFlows];
  if (!ids.length) return;
  try {
    await api('/api/flows/delete', { method: 'POST', body: { ids } });
    clearFlowSelection();
    toast(`Deleted ${ids.length} request${ids.length > 1 ? 's' : ''}`);
  } catch (err) {
    toast(err.message, true);
  }
}

function removeFlows(ids) {
  for (const id of ids) {
    const row = state.rows.get(id);
    if (row) row.remove();
    state.rows.delete(id);
    state.flows.delete(id);
    state.pickedFlows.delete(id);
    if (state.selectedId === id) {
      state.selectedId = null;
      el('detail').innerHTML = '';
      el('detail').appendChild(h('div', { class: 'empty' }, h('p', { class: 'muted' }, 'Select a request to inspect it.')));
    }
  }
  renderFlowBulk();
  updateCounter();
}

function statusNode(flow) {
  if (flow.state === 'cancelled') return h('span', { class: 's-err' }, '✕');
  if (flow.state === 'error') return h('span', { class: 's-err' }, 'err');
  if (flow.state && flow.state.startsWith('paused')) return h('span', { class: 's-4' }, '⏸');
  if (!flow.status) return h('span', { class: 's-pending' }, '…');
  return h('span', { class: `s-${String(flow.status)[0]}` }, flow.status);
}

function badges(flow) {
  const out = [];
  if (flow.modified && (flow.modified.request || flow.modified.response)) {
    out.push(h('span', { class: 'badge mod', title: (flow.rulesApplied || []).map((r) => r.name).join(', ') || 'modified' }, ' MOD'));
  }
  if (flow.redirectedTo) out.push(h('span', { class: 'badge mock', title: flow.redirectedTo }, ' →'));
  if (flow.clientIp === 'replay') out.push(h('span', { class: 'badge replay' }, ' REPLAY'));
  if (flow.pausedPhase) out.push(h('span', { class: 'badge paused' }, ` PAUSED:${flow.pausedPhase}`));
  return out;
}

function matchesFilter(flow) {
  const text = el('quickFilter').value.trim().toLowerCase();
  const source = el('sourceFilter').value;
  const type = el('typeFilter').value;
  const status = el('statusFilter').value;
  if (source && flow.clientSource !== source) return false;
  if (type && flow.resourceType !== type) return false;
  if (status === 'err' && !(flow.state === 'error' || flow.state === 'cancelled')) return false;
  if (status === 'mod' && !(flow.modified && (flow.modified.request || flow.modified.response))) return false;
  if (/^[2345]$/.test(status) && String(flow.status || '')[0] !== status) return false;
  if (text && state.searchIds && !state.searchIds.has(flow.id)) return false;
  return true;
}

function scheduleFlowSearch() {
  clearTimeout(state.searchTimer);
  const query = el('quickFilter').value.trim();
  if (!query) {
    state.searchIds = null;
    state.searchVersion++;
    return applyFilter();
  }
  state.searchTimer = setTimeout(() => runFlowSearch(query), 180);
}

async function runFlowSearch(query) {
  const version = ++state.searchVersion;
  try {
    const data = await api(`/api/flows?q=${encodeURIComponent(query)}`);
    if (version !== state.searchVersion || query !== el('quickFilter').value.trim()) return;
    state.searchIds = new Set(data.flows.map((flow) => flow.id));
    applyFilter();
  } catch (err) {
    toast(err.message, true);
  }
}

async function applySourceFilter() {
  const source = el('sourceFilter').value;
  if (source) {
    const unclassified = [...state.flows.values()].filter((flow) => !flow.clientSource);
    await Promise.all(unclassified.map(async (flow) => {
      try {
        const detail = await api(`/api/flows/${flow.id}`);
        flow.clientSource = detail.clientSource || detectClientSource(detail.request && detail.request.headers);
      } catch {
        flow.clientSource = 'other';
      }
    }));
  }
  applyFilter();
}

function detectClientSource(headers) {
  const pairs = headers || [];
  const userAgent = String((pairs.find(([name]) => name.toLowerCase() === 'user-agent') || [])[1] || '');
  const hasFetchMetadata = pairs.some(([name]) => name.toLowerCase().startsWith('sec-fetch-'));
  const hasBrowserUserAgent = /Mozilla\/|Chrome\/|Chromium\/|Edg\/|Firefox\/|Safari\//i.test(userAgent);
  return hasFetchMetadata || hasBrowserUserAgent ? 'browser' : 'other';
}

function applyFilter() {
  let shown = 0;
  for (const [id, row] of state.rows) {
    const visible = matchesFilter(state.flows.get(id));
    row.style.display = visible ? '' : 'none';
    if (visible) shown++;
  }
  updateCounter(shown);
}

function updateCounter(shown) {
  const total = state.flows.size;
  const visible = shown === undefined ? [...state.rows.values()].filter((r) => r.style.display !== 'none').length : shown;
  el('flowCounter').textContent = visible === total ? `${total} requests` : `${visible} of ${total} requests`;
  el('flowEmpty').hidden = total > 0;
}

/* ------------------------------------------------------------------ detail */

async function openDetail(id, keepTab) {
  state.selectedId = id;
  if (!keepTab) state.detailTab = 'overview';
  for (const [rowId, row] of state.rows) row.classList.toggle('selected', rowId === id);
  let flow;
  try {
    flow = await api(`/api/flows/${id}`);
  } catch (err) {
    return toast(err.message, true);
  }
  if (state.selectedId !== id) return;
  renderDetail(flow);
}

function renderDetail(flow) {
  const container = el('detail');
  container.innerHTML = '';

  container.appendChild(h('div', { class: 'detail-header' },
    h('div', {},
      h('span', { class: `method m-${flow.method}` }, flow.method + ' '),
      h('span', { class: `s-${String(flow.status || '')[0] || 'pending'}` }, flow.status ? `${flow.status} ${flow.statusMessage || ''}` : flow.state)
    ),
    h('div', { class: 'url' }, flow.url),
    flow.redirectedTo ? h('div', { class: 'small muted' }, `redirected to ${flow.redirectedTo}`) : null,
    flow.error ? h('div', { class: 'small s-err' }, flow.error) : null,
    (flow.rulesApplied || []).length
      ? h('div', { class: 'small muted' }, `rules: ${flow.rulesApplied.map((r) => `${r.name} (${r.phase})`).join(', ')}`)
      : null,
    h('div', { class: 'detail-actions' },
      h('button', { class: 'btn small', onclick: () => replay(flow.id, false) }, 'Replay'),
      h('button', { class: 'btn small', onclick: () => openEditAndReplay(flow) }, 'Edit & replay'),
      h('button', { class: 'btn small ghost', onclick: () => copyCurl(flow.id) }, 'Copy as cURL'),
      h('button', { class: 'btn small ghost', onclick: () => ruleFromFlow(flow) }, 'Create rule from this'),
      flow.pausedPhase ? h('button', { class: 'btn small primary', onclick: () => openBreakpointEditor(flow.id) }, 'Edit at breakpoint') : null
    )
  ));

  const tabs = [
    ['overview', 'Overview'],
    ['req-headers', `Request headers (${flow.request.headers.length})`],
    ['req-body', 'Request body'],
    ['res-headers', flow.response ? `Response headers (${flow.response.headers.length})` : 'Response headers'],
    ['res-body', 'Response body'],
    ...(flow.resourceType === 'websocket' ? [['ws-frames', `Frames (${(flow.webSocketFrames || []).length})`]] : []),
    ['diff', 'Diff'],
    ['timing', 'Timing']
  ];
  const bar = h('div', { class: 'subtabs' });
  const body = h('div', { class: 'detail-body' });
  for (const [key, label] of tabs) {
    bar.appendChild(h('button', {
      class: `subtab${state.detailTab === key ? ' active' : ''}`,
      onclick: () => {
        state.detailTab = key;
        renderDetail(flow);
      }
    }, label));
  }
  container.appendChild(bar);
  container.appendChild(body);

  switch (state.detailTab) {
    case 'req-headers':
      body.appendChild(headerTable(flow.request.headers));
      break;
    case 'req-body':
      body.appendChild(bodyView(flow.request, flow.id, 'request'));
      break;
    case 'res-headers':
      body.appendChild(flow.response ? headerTable(flow.response.headers) : h('p', { class: 'muted' }, 'No response yet.'));
      break;
    case 'res-body':
      body.appendChild(flow.response ? bodyView(flow.response, flow.id, 'response') : h('p', { class: 'muted' }, 'No response yet.'));
      break;
    case 'ws-frames':
      body.appendChild(webSocketFramesView(flow));
      break;
    case 'diff':
      body.appendChild(diffView(flow));
      break;
    case 'timing':
      body.appendChild(timingWaterfall(flow));
      body.appendChild(kvTable({
        Started: new Date(flow.startTime).toLocaleTimeString(),
        Duration: formatMs(flow.duration),
        'Request received': relative(flow.timing.requestReceived, flow.startTime),
        'Upstream started': relative(flow.timing.upstreamStart, flow.startTime),
        'First byte': relative(flow.timing.firstByte, flow.startTime),
        'Response complete': relative(flow.timing.responseReceived, flow.startTime)
      }));
      break;
    default:
      body.appendChild(kvTable({
        URL: flow.url,
        Method: flow.method,
        Status: flow.status ? `${flow.status} ${flow.statusMessage || ''}` : flow.state,
        Type: flow.resourceType,
        Protocol: flow.scheme.toUpperCase(),
        Source: flow.clientSource === 'browser' ? 'Browser' : 'Other client',
        'Client IP': flow.clientIp || '',
        'Request size': formatBytes(flow.requestSize),
        'Response size': formatBytes(flow.responseSize),
        'Content type': flow.contentType || '',
        Modified: `${flow.modified.request ? 'request ' : ''}${flow.modified.response ? 'response' : ''}` || 'no',
        Errors: (flow.errors || []).join('; ')
      }));
  }
}

function webSocketFramesView(flow) {
  const frames = flow.webSocketFrames || [];
  if (!frames.length) return h('p', { class: 'muted' }, 'No WebSocket messages captured yet.');
  const wrap = h('div', { class: 'ws-frames' });
  for (const frame of frames) {
    const area = h('textarea', { class: 'input', spellcheck: 'false' }, frame.data);
    wrap.appendChild(h('section', { class: 'ws-frame' },
      h('header', {},
        h('strong', {}, frame.direction),
        h('span', { class: 'muted small' }, `${new Date(frame.time).toLocaleTimeString()} · ${formatBytes(frame.size)}${frame.binary ? ' · base64' : ''}`),
        h('button', {
          class: 'btn small ghost',
          onclick: async () => {
            await api(`/api/flows/${flow.id}/websocket-frame`, {
              method: 'POST', body: { direction: frame.direction.startsWith('server-to-client') ? 'server-to-client' : 'client-to-server', data: area.value, binary: frame.binary }
            });
            toast('Edited frame sent');
          }
        }, 'Send edited')),
      area));
  }
  return wrap;
}

function diffView(flow) {
  const wrap = h('div', { class: 'diff-view' });
  const sections = [
    ['Request', flow.originalRequest, flow.request],
    ['Response', flow.originalResponse, flow.response]
  ];
  let changed = false;
  for (const [label, before, after] of sections) {
    if (!before || !after || sameMessage(before, after)) continue;
    changed = true;
    wrap.appendChild(h('h3', { class: 'section-title' }, label));
    wrap.appendChild(h('div', { class: 'diff-grid' },
      diffColumn('Original', before, 'before'),
      diffColumn('Modified', after, 'after')));
  }
  return changed ? wrap : h('p', { class: 'muted' }, 'No request or response changes were recorded.');
}

function sameMessage(left, right) {
  return messageText(left) === messageText(right);
}

function diffColumn(label, message, kind) {
  return h('section', { class: `diff-column ${kind}` },
    h('strong', {}, label),
    h('pre', { class: 'code' }, messageText(message)));
}

function messageText(message) {
  const start = message.method
    ? `${message.method} ${message.url}`
    : `${message.statusCode || ''} ${message.statusMessage || ''}`.trim();
  return [start, ...message.headers.map(([name, value]) => `${name}: ${value}`), '', message.bodyEncoding === 'text' ? message.body : `[${message.bodyEncoding || 'binary'} body]`].join('\n');
}

function timingWaterfall(flow) {
  const timing = flow.timing || {};
  const end = timing.end || flow.endTime || Date.now();
  const total = Math.max(1, end - flow.startTime);
  const phases = [
    ['Receive request', flow.startTime, timing.requestReceived],
    ['Rules / queue', timing.requestReceived, timing.upstreamStart],
    ['Server wait', timing.upstreamStart, timing.firstByte],
    ['Download', timing.firstByte, timing.responseReceived],
    ['Response rules / send', timing.responseReceived, end]
  ].filter(([, start, finish]) => start && finish && finish >= start);
  const chart = h('div', { class: 'waterfall' });
  for (const [label, start, finish] of phases) {
    chart.appendChild(h('div', { class: 'waterfall-row' },
      h('span', {}, label),
      h('div', { class: 'waterfall-track' }, h('i', {
        style: `left:${((start - flow.startTime) / total) * 100}%;width:${Math.max(1, ((finish - start) / total) * 100)}%`,
        title: `${label}: ${formatMs(finish - start)}`
      })),
      h('em', {}, formatMs(finish - start))));
  }
  return chart;
}

function relative(time, start) {
  return time ? `+${time - start}ms` : '—';
}

function headerTable(pairs) {
  const table = h('table', { class: 'kv' });
  for (const [name, value] of pairs) {
    table.appendChild(h('tr', {}, h('td', {}, name), h('td', {}, value)));
  }
  return table;
}

function kvTable(object) {
  const table = h('table', { class: 'kv' });
  for (const [key, value] of Object.entries(object)) {
    if (value === '' || value === undefined) continue;
    table.appendChild(h('tr', {}, h('td', {}, key), h('td', {}, String(value))));
  }
  return table;
}

function bodyView(side, flowId, which) {
  const wrap = h('div');
  if (side.bodyTruncated) {
    return h('p', { class: 'muted' }, 'Body was too large to buffer and was streamed through untouched.');
  }
  if (!side.body) return h('p', { class: 'muted' }, 'Empty body.');

  const contentType = (side.headers.find(([n]) => n.toLowerCase() === 'content-type') || [])[1] || '';
  wrap.appendChild(h('div', { class: 'row', style: 'margin-bottom:8px' },
    h('span', { class: 'muted small' }, `${formatBytes(side.bodySize)} · ${side.bodyEncoding} · ${contentType.split(';')[0] || 'unknown'}`),
    h('button', { class: 'btn small ghost', onclick: () => navigator.clipboard.writeText(side.body).then(() => toast('Copied')) }, 'Copy'),
    h('a', { class: 'btn small ghost', href: `/api/flows/${flowId}/body?side=${which}` }, 'Download')
  ));

  if (side.bodyEncoding === 'base64' && /^image\//.test(contentType)) {
    wrap.appendChild(h('img', { src: `data:${contentType};base64,${side.body}`, style: 'max-width:100%;border-radius:8px' }));
    return wrap;
  }
  let text = side.body;
  if (side.bodyEncoding === 'text') {
    try {
      text = JSON.stringify(JSON.parse(side.body), null, 2);
    } catch { /* not JSON, show as-is */ }
  }
  wrap.appendChild(h('pre', { class: 'code' }, text));
  return wrap;
}

async function replay(id, applyRules) {
  try {
    const flow = await api(`/api/flows/${id}/replay`, { method: 'POST', body: { applyRules } });
    toast(`Replayed → ${flow.status || flow.state}`);
    openDetail(flow.id);
  } catch (err) {
    toast(err.message, true);
  }
}

async function copyCurl(id) {
  try {
    const data = await api(`/api/flows/${id}/curl`);
    await navigator.clipboard.writeText(data.command);
    toast('cURL command copied');
  } catch (err) {
    toast(err.message, true);
  }
}

function openEditAndReplay(flow) {
  const form = requestEditor(flow.request);
  openModal(`Edit & replay`, form.node, [
    { label: 'Send', primary: true, onClick: async () => {
      try {
        const patch = form.read();
        const replayed = await api(`/api/flows/${flow.id}/replay`, {
          method: 'POST',
          body: { overrides: patch, applyRules: form.applyRules() }
        });
        closeModal();
        toast(`Replayed → ${replayed.status || replayed.state}`);
        openDetail(replayed.id);
      } catch (err) {
        toast(err.message, true);
      }
    } },
    { label: 'Cancel', onClick: closeModal }
  ]);
}

async function exportHar() {
  try {
    const har = await api('/api/flows/har');
    download('network-modifier.har', JSON.stringify(har, null, 2));
  } catch (err) {
    toast(err.message, true);
  }
}

function download(filename, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = h('a', { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* -------------------------------------------------------------- breakpoints */

function renderBreakpointBar() {
  const bar = el('breakpointBar');
  const count = state.pending.length;
  bar.hidden = count === 0;
  if (count) {
    el('breakpointText').textContent = `${count} request${count > 1 ? 's' : ''} paused at a breakpoint`;
  }
  for (const [id, row] of state.rows) {
    const flow = state.flows.get(id);
    if (flow) paintRow(row, flow);
  }
}

async function openBreakpointEditor(id) {
  let flow;
  try {
    flow = await api(`/api/flows/${id}`);
  } catch (err) {
    return toast(err.message, true);
  }
  const phase = flow.pausedPhase || (state.pending.find((p) => p.id === id) || {}).phase;
  if (!phase) return toast('This request is no longer paused', true);

  const editor = phase === 'request' ? requestEditor(flow.request, true) : responseEditor(flow.response);
  openModal(`Breakpoint · ${phase} · ${flow.method} ${flow.url}`, editor.node, [
    { label: 'Continue with changes', primary: true, onClick: async () => {
      await api(`/api/flows/${id}/resume`, { method: 'POST', body: { patch: editor.read() } });
      closeModal();
    } },
    { label: 'Continue unchanged', onClick: async () => {
      await api(`/api/flows/${id}/resume`, { method: 'POST', body: {} });
      closeModal();
    } },
    { label: 'Abort', danger: true, onClick: async () => {
      await api(`/api/flows/${id}/abort`, { method: 'POST', body: { reason: 'Aborted at breakpoint' } });
      closeModal();
    } }
  ]);
}

function headersEditor(pairs) {
  const box = h('div');
  const addRow = (name = '', value = '') => {
    const row = h('div', { class: 'row', style: 'margin-bottom:4px' },
      h('input', { class: 'input', value: name, placeholder: 'Header' }),
      h('input', { class: 'input', style: 'flex:2', value, placeholder: 'Value' }),
      h('button', { class: 'btn small ghost danger', onclick: (e) => { e.preventDefault(); row.remove(); } }, '✕')
    );
    box.appendChild(row);
  };
  for (const [name, value] of pairs) addRow(name, value);
  const wrap = h('div', {}, box,
    h('button', { class: 'btn small ghost', onclick: (e) => { e.preventDefault(); addRow(); } }, '+ Add header'));
  wrap.read = () => [...box.children]
    .map((row) => [row.children[0].value.trim(), row.children[1].value])
    .filter(([name]) => name);
  return wrap;
}

function bodyEditor(side) {
  const isBase64 = side.bodyEncoding === 'base64';
  const select = h('select', { class: 'input' },
    h('option', { value: 'text' }, 'text'),
    h('option', { value: 'base64' }, 'base64'));
  select.value = isBase64 ? 'base64' : 'text';
  let text = side.body || '';
  const area = h('textarea', { class: 'input', style: 'min-height:170px' }, text);
  const wrap = h('div', {},
    h('div', { class: 'row', style: 'margin-bottom:6px' },
      h('span', { class: 'muted small' }, 'Body encoding'), select,
      h('button', { class: 'btn small ghost', onclick: (e) => {
        e.preventDefault();
        try {
          area.value = JSON.stringify(JSON.parse(area.value), null, 2);
        } catch { toast('Not valid JSON', true); }
      } }, 'Pretty JSON')),
    area);
  wrap.read = () => ({ body: area.value, bodyEncoding: select.value });
  return wrap;
}

function requestEditor(request, forBreakpoint) {
  const method = h('select', { class: 'input' }, ...METHODS.map((m) => h('option', { value: m }, m)));
  if (!METHODS.includes(request.method)) method.appendChild(h('option', { value: request.method }, request.method));
  method.value = request.method;
  const url = h('input', { class: 'input grow', value: request.url });
  const headers = headersEditor(request.headers);
  const body = bodyEditor(request);
  const applyRules = h('input', { type: 'checkbox' });

  const node = h('div', {},
    h('div', { class: 'field' }, h('label', {}, 'Request line'), h('div', { class: 'row' }, method, url)),
    h('div', { class: 'field' }, h('label', {}, 'Headers'), headers),
    h('div', { class: 'field' }, h('label', {}, 'Body'), body),
    forBreakpoint ? null : h('label', { class: 'check' }, applyRules, ' Apply rules to the replayed request')
  );
  return {
    node,
    applyRules: () => applyRules.checked,
    read: () => ({ method: method.value, url: url.value.trim(), headers: headers.read(), ...body.read() })
  };
}

function responseEditor(response) {
  const status = h('input', { class: 'input', type: 'number', value: response.statusCode, style: 'max-width:110px' });
  const message = h('input', { class: 'input', value: response.statusMessage || '' });
  const headers = headersEditor(response.headers);
  const body = bodyEditor(response);
  const node = h('div', {},
    h('div', { class: 'field' }, h('label', {}, 'Status'), h('div', { class: 'row' }, status, message)),
    h('div', { class: 'field' }, h('label', {}, 'Headers'), headers),
    h('div', { class: 'field' }, h('label', {}, 'Body'), body)
  );
  return {
    node,
    read: () => ({
      statusCode: Number(status.value),
      statusMessage: message.value,
      headers: headers.read(),
      ...body.read()
    })
  };
}

/* ------------------------------------------------------------------- modals */

function openModal(title, content, buttons) {
  const modal = el('modal');
  modal.innerHTML = '';
  modal.appendChild(h('div', { class: 'modal-header' },
    h('strong', {}, title),
    h('button', { class: 'btn small ghost', onclick: closeModal }, '✕')));
  modal.appendChild(h('div', { class: 'modal-body' }, content));
  modal.appendChild(h('div', { class: 'modal-footer' },
    ...buttons.map((button) => h('button', {
      class: `btn${button.primary ? ' primary' : ''}${button.danger ? ' danger' : ''}`,
      onclick: async () => {
        try {
          await button.onClick();
        } catch (err) {
          toast(err.message, true);
        }
      }
    }, button.label))));
  el('modalBackdrop').hidden = false;
}

function closeModal() {
  el('modalBackdrop').hidden = true;
  el('modal').innerHTML = '';
}

/* ------------------------------------------------------------------- connect */

async function openConnectDialog() {
  let system;
  try {
    system = await api('/api/system');
  } catch (err) {
    return toast(err.message, true);
  }

  const startUrl = h('input', { class: 'input grow', placeholder: 'https://example.com (optional)' });
  const browserBox = h('div', { class: 'row' });
  for (const browser of system.browsers) {
    browserBox.appendChild(h('button', {
      class: 'btn',
      onclick: async () => {
        const result = await api('/api/system/browser', {
          method: 'POST',
          body: { id: browser.id, url: startUrl.value.trim() }
        });
        toast(`${result.browser} launched through the proxy`);
      }
    }, `Launch ${browser.name}`));
  }
  if (!system.browsers.length) {
    browserBox.appendChild(h('span', { class: 'muted small' }, 'No Chromium-based browser found on this machine.'));
  }

  const proxyState = h('span', { class: 'muted small' }, describeSystemProxy(system.systemProxy));
  const proxyButton = h('button', {
    class: system.systemProxy.enabled ? 'btn' : 'btn primary',
    onclick: async () => {
      const enabling = !system.systemProxy.enabled;
      const result = await api('/api/system/proxy', { method: 'POST', body: { enabled: enabling } });
      system.systemProxy = result.systemProxy;
      proxyState.textContent = describeSystemProxy(result.systemProxy);
      proxyButton.textContent = result.systemProxy.enabled ? 'Turn system proxy off' : 'Turn system proxy on';
      proxyButton.className = result.systemProxy.enabled ? 'btn' : 'btn primary';
      toast(result.systemProxy.enabled ? 'All system traffic now flows through the proxy' : 'System proxy restored');
    }
  }, system.systemProxy.enabled ? 'Turn system proxy off' : 'Turn system proxy on');

  const content = h('div', {},
    h('div', { class: 'section-title' }, 'Step 1 — trust the certificate (once)'),
    h('p', { class: 'muted small' }, 'Required to read HTTPS traffic. The certificate is generated locally and never leaves this machine.'),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const result = await api('/api/system/trust', { method: 'POST', body: {} });
          toast(result.ok ? 'Certificate trusted — restart your browser' : `${result.error} ${result.hint || ''}`, !result.ok);
        }
      }, 'Trust certificate now'),
      h('a', { class: 'btn ghost', href: '/api/ca.crt' }, 'Download instead')),

    h('div', { class: 'section-title' }, 'Step 2 — send traffic here'),
    h('p', { class: 'muted small' }, 'Easiest option: launch a browser in a separate profile already pointed at the proxy. Your normal browser session is untouched.'),
    h('div', { class: 'field' }, h('label', {}, 'Open at'), startUrl),
    browserBox,

    h('div', { class: 'section-title' }, 'Or route the whole machine'),
    h('div', { class: 'row' }, proxyButton, proxyState),
    h('p', { class: 'muted small' },
      system.platform === 'darwin'
        ? 'macOS may ask for an administrator password. It is switched back off automatically when Network Modifier stops.'
        : 'This is switched back off automatically when Network Modifier stops.')
  );

  openModal('Connect a browser', content, [{ label: 'Done', primary: true, onClick: closeModal }]);
}

function describeSystemProxy(proxy) {
  if (proxy.unsupported) return 'Not supported on this OS — configure the proxy manually.';
  return proxy.enabled ? `Currently on → ${proxy.host}:${proxy.port}` : 'Currently off';
}

/* -------------------------------------------------------------------- rules */

function visibleRules() {
  const query = (el('ruleSearch').value || '').trim().toLowerCase();
  const profile = el('ruleProfile').value || (state.settings.activeRuleProfiles || ['*'])[0];
  return state.rules.filter((rule) => {
    if (profile !== '*' && (rule.profile || 'default') !== profile) return false;
    if (!query) return true;
    const haystack = `${rule.name} ${rule.folder || ''} ${rule.match.urlPattern} ${rule.actions.map((a) => a.type).join(' ')}`;
    return haystack.toLowerCase().includes(query);
  });
}

function renderRules() {
  renderRuleList();
  syncEditor();
}

function renderRuleList() {
  el('rulesCount').textContent = state.rules.filter((r) => r.enabled).length;
  const profileSelect = el('ruleProfile');
  const selectedProfile = (state.settings.activeRuleProfiles || ['*'])[0];
  const profiles = [...new Set(['default', ...state.rules.map((rule) => rule.profile || 'default')])].sort();
  profileSelect.innerHTML = '';
  profileSelect.appendChild(h('option', { value: '*' }, 'All profiles'));
  for (const profile of profiles) profileSelect.appendChild(h('option', { value: profile }, profile));
  profileSelect.value = selectedProfile === '*' || profiles.includes(selectedProfile) ? selectedProfile : 'default';
  const list = el('ruleList');
  const rules = visibleRules();
  list.innerHTML = '';

  if (!rules.length) {
    list.appendChild(h('div', { class: 'empty' },
      h('p', { class: 'muted' }, state.rules.length ? 'No rules match your search.' : 'No rules yet.')));
  }

  const groups = new Map();
  for (const rule of rules) {
    const folder = rule.folder || 'Ungrouped';
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(rule);
  }

  for (const [folder, folderRules] of groups) {
    const storageKey = `netmod-rule-folder:${profileSelect.value}:${folder}`;
    const collapsed = localStorage.getItem(storageKey) === 'closed';
    const contents = h('div', { class: 'rule-folder-contents', hidden: collapsed });
    const toggle = h('button', {
      class: 'rule-folder',
      type: 'button',
      'aria-expanded': String(!collapsed),
      onclick: () => {
        const closing = !contents.hidden;
        contents.hidden = closing;
        toggle.setAttribute('aria-expanded', String(!closing));
        localStorage.setItem(storageKey, closing ? 'closed' : 'open');
      }
    },
    h('span', { class: 'rule-folder-chevron', 'aria-hidden': 'true' }, '›'),
    h('span', { class: 'rule-folder-name' }, folder),
    h('span', { class: 'rule-folder-count' }, folderRules.length));

    for (const rule of folderRules) contents.appendChild(renderRuleItem(rule));
    list.appendChild(h('section', { class: 'rule-folder-group' }, toggle, contents));
  }

  renderRuleBulk();
}

function renderRuleItem(rule) {
  const summary = describeRule(rule);
  return h('div', {
      class: `rule-item${rule.id === state.selectedRuleId ? ' selected' : ''}${rule.enabled ? '' : ' disabled'}`,
      draggable: 'true',
      'data-rule-id': rule.id,
      onclick: (event) => {
        if (event.target.closest('input')) return;
        selectRule(rule.id);
      },
      ondragstart: (event) => event.dataTransfer.setData('text/plain', rule.id),
      ondragover: (event) => event.preventDefault(),
      ondrop: (event) => {
        event.preventDefault();
        reorderRule(event.dataTransfer.getData('text/plain'), rule.id);
      }
    },
      h('input', {
        type: 'checkbox',
        checked: state.pickedRules.has(rule.id),
        style: 'margin-top:3px',
        onchange: (event) => {
          if (event.target.checked) state.pickedRules.add(rule.id);
          else state.pickedRules.delete(rule.id);
          renderRuleBulk();
        }
      }),
      h('label', { class: 'switch' },
        h('input', {
          type: 'checkbox',
          checked: rule.enabled,
          onchange: (event) => toggleRule(rule.id, event.target.checked)
        }),
        h('span')),
      h('div', { class: 'rule-body' },
        h('div', { class: 'rule-name', title: rule.name }, rule.name),
        h('div', { class: 'rule-meta', title: summary }, `P${rule.priority || 0} · ${summary}`))
  );
}

async function reorderRule(sourceId, targetId) {
  if (!sourceId || sourceId === targetId) return;
  const ordered = [...state.rules];
  const sourceIndex = ordered.findIndex((rule) => rule.id === sourceId);
  const targetIndex = ordered.findIndex((rule) => rule.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [moved] = ordered.splice(sourceIndex, 1);
  ordered.splice(targetIndex, 0, moved);
  const total = ordered.length;
  ordered.forEach((rule, index) => { rule.priority = total - index; });
  try {
    await api('/api/rules', { method: 'PUT', body: { rules: ordered } });
  } catch (err) {
    toast(err.message, true);
  }
}

function syncEditor() {
  const selected = state.rules.find((r) => r.id === state.selectedRuleId);
  if (!selected) {
    state.draft = null;
    el('ruleEditor').innerHTML = '';
    el('ruleEditor').appendChild(h('div', { class: 'empty' },
      h('p', {}, 'No rule selected'),
      h('p', { class: 'muted' }, 'Pick a rule on the left, or create a new one.')));
    return;
  }
  // Keep unsaved edits alive across background updates.
  if (state.draft && state.draft.id === selected.id && state.dirty) return;
  state.draft = JSON.parse(JSON.stringify(selected));
  state.dirty = false;
  renderRuleEditor();
}

function describeRule(rule) {
  const where = rule.match.urlPattern ? `${rule.match.matchType} "${rule.match.urlPattern}"` : 'all requests';
  const what = rule.actions.length
    ? rule.actions.map((a) => actionLabel(a.type)).join(' · ')
    : 'no actions yet';
  return `${where} → ${what}`;
}

function renderRuleBulk() {
  const count = state.pickedRules.size;
  el('ruleBulk').hidden = count === 0;
  el('ruleBulkCount').textContent = `${count} selected`;
  const shown = visibleRules();
  el('ruleSelectAll').checked = shown.length > 0 && shown.every((r) => state.pickedRules.has(r.id));
}

function selectRule(id) {
  if (state.dirty && !confirm('Discard unsaved changes to this rule?')) return;
  state.selectedRuleId = id;
  state.draft = null;
  state.dirty = false;
  renderRules();
}
async function toggleRule(id, enabled) {
  try {
    await api('/api/rules/toggle', { method: 'POST', body: { ids: [id], enabled } });
  } catch (err) {
    toast(err.message, true);
  }
}

async function bulkRules(endpoint, extra) {
  const ids = [...state.pickedRules];
  if (!ids.length) return;
  try {
    await api(endpoint, { method: 'POST', body: { ids, ...extra } });
    state.pickedRules.clear();
    renderRuleBulk();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteSelectedRules() {
  const ids = [...state.pickedRules];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} rule${ids.length > 1 ? 's' : ''}?`)) return;
  if (ids.includes(state.selectedRuleId)) {
    state.selectedRuleId = null;
    state.draft = null;
    state.dirty = false;
  }
  await bulkRules('/api/rules/delete', {});
  toast(`Deleted ${ids.length} rule${ids.length > 1 ? 's' : ''}`);
}

const MATCH_HINTS = {
  contains: 'Matches when the URL contains this text. Leave empty to match every request.',
  wildcard: 'Use * for any text and ? for one character. Captures fill $1, $2 … e.g. */api/*',
  regex: 'Full JavaScript regular expression. Capture groups fill $1, $2 …',
  exact: 'The URL must be exactly this.',
  host: 'Matches the host only, wildcards allowed. e.g. *.example.com'
};

function renderRuleEditor() {
  const draft = state.draft;
  const editor = el('ruleEditor');
  editor.innerHTML = '';

  const form = (state.form && state.form.ruleId === draft.id && state.form.keep)
    ? state.form
    : formFromRule(draft);
  form.keep = false;
  state.form = form;

  const saveBtn = h('button', { class: 'btn primary', onclick: saveDraft }, 'Save');
  const dirtyDot = h('span', { class: 'dirty-dot', hidden: !state.dirty });
  const markDirty = () => {
    state.dirty = true;
    dirtyDot.hidden = false;
  };
  state.markDirty = markDirty;

  const title = h('strong', { class: 'editor-title' }, draft.name || 'Rule');
  const name = h('input', { class: 'input grow', value: draft.name, placeholder: 'Rule name' });
  name.addEventListener('input', () => {
    draft.name = name.value;
    title.textContent = name.value || 'Rule';
    markDirty();
  });

  const enabled = h('input', {
    type: 'checkbox',
    checked: draft.enabled,
    onchange: () => { draft.enabled = enabled.checked; markDirty(); }
  });
  const profile = h('input', { class: 'input', value: draft.profile || 'default', placeholder: 'default' });
  const folder = h('input', { class: 'input', value: draft.folder || '', placeholder: 'Optional folder' });
  const priority = h('input', { class: 'input', type: 'number', value: draft.priority || 0 });
  for (const input of [profile, folder, priority]) input.addEventListener('input', markDirty);

  const actionSelect = h('select', { class: 'input', style: 'max-width:320px' },
    ...RULE_ACTIONS.map(([value, label]) => h('option', { value }, label)));
  actionSelect.value = form.action;
  actionSelect.addEventListener('change', () => {
    form.action = actionSelect.value;
    form.advanced = actionSelect.value === 'advanced';
    form.keep = true;
    markDirty();
    renderRuleEditor();
  });

  editor.appendChild(h('div', { class: 'editor-head' },
    h('label', { class: 'switch', title: 'Enable or disable this rule' }, enabled, h('span')),
    title,
    dirtyDot,
    saveBtn,
    h('button', {
      class: 'btn ghost',
      onclick: () => { state.draft = null; state.dirty = false; renderRules(); }
    }, 'Revert'),
    h('button', {
      class: 'btn ghost',
      onclick: async () => {
        await api('/api/rules/duplicate', { method: 'POST', body: { ids: [draft.id] } });
        toast('Rule duplicated');
      }
    }, 'Duplicate'),
    h('button', {
      class: 'btn ghost danger',
      onclick: async () => {
        if (!confirm(`Delete "${draft.name}"?`)) return;
        state.selectedRuleId = null;
        state.draft = null;
        state.dirty = false;
        await api(`/api/rules/${draft.id}`, { method: 'DELETE' });
      }
    }, 'Delete')));

  /* ---------------------------------------------------------------- when */

  const matchType = h('select', { class: 'input', style: 'max-width:130px' },
    ...Object.keys(MATCH_HINTS).map((t) => h('option', { value: t }, t)));
  matchType.value = draft.match.matchType;
  const pattern = h('input', { class: 'input grow', value: draft.match.urlPattern, placeholder: 'example.com/api/*' });
  const hint = h('p', { class: 'muted small', style: 'margin:6px 0 0' }, MATCH_HINTS[draft.match.matchType]);

  matchType.addEventListener('change', () => {
    draft.match.matchType = matchType.value;
    hint.textContent = MATCH_HINTS[matchType.value];
    markDirty();
    runTest();
  });
  pattern.addEventListener('input', () => { draft.match.urlPattern = pattern.value; markDirty(); runTest(); });

  const testUrl = h('input', { class: 'input grow', placeholder: 'Paste a URL to test this rule against…' });
  const testResult = h('span', { class: 'match-result', hidden: true });
  let testTimer = null;
  const runTest = () => {
    clearTimeout(testTimer);
    testTimer = setTimeout(async () => {
      if (!testUrl.value.trim()) {
        testResult.hidden = true;
        return;
      }
      try {
        const result = await api('/api/rules/test', {
          method: 'POST',
          body: { rule: collectDraft(), url: testUrl.value.trim() }
        });
        testResult.hidden = false;
        testResult.className = `match-result ${result.matches ? 'yes' : 'no'}`;
        testResult.textContent = result.error
          ? result.error
          : result.matches
            ? `Matches${result.captures.length ? ` — $1…: ${result.captures.join(', ')}` : ''}`
            : 'Does not match';
      } catch (err) {
        testResult.hidden = false;
        testResult.className = 'match-result no';
        testResult.textContent = err.message;
      }
    }, 250);
  };
  testUrl.addEventListener('input', runTest);

  const methodChips = chipGroup(METHODS, draft.match.methods, () => {
    draft.match.methods = methodChips.read();
    markDirty();
  });
  const typeChips = chipGroup(state.resourceTypes, draft.match.resourceTypes, () => {
    draft.match.resourceTypes = typeChips.read();
    markDirty();
  });
  const statusCodes = h('input', {
    class: 'input', value: (draft.match.statusCodes || []).join(', '), placeholder: 'e.g. 404, 5xx, 200-299'
  });
  const protocol = h('select', { class: 'input', style: 'max-width:110px' },
    ...['any', 'http', 'https'].map((p) => h('option', { value: p }, p)));
  protocol.value = draft.match.protocol || 'any';
  const caseSensitive = h('input', { type: 'checkbox', checked: draft.match.caseSensitive });
  const negate = h('input', { type: 'checkbox', checked: draft.match.negate });

  statusCodes.addEventListener('change', () => {
    draft.match.statusCodes = statusCodes.value.split(',').map((s) => s.trim()).filter(Boolean);
    markDirty();
  });
  protocol.addEventListener('change', () => { draft.match.protocol = protocol.value; markDirty(); });
  caseSensitive.addEventListener('change', () => { draft.match.caseSensitive = caseSensitive.checked; markDirty(); });
  negate.addEventListener('change', () => { draft.match.negate = negate.checked; markDirty(); });

  const whenCard = h('div', { class: 'card' },
    h('h3', {}, 'Rule'),
    h('div', { class: 'form-row' },
      h('label', {}, 'Label'),
      h('div', {}, name)),
    h('div', { class: 'form-row' },
      h('label', {}, 'Organization'),
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', {}, 'Profile'), profile),
        h('div', { class: 'field' }, h('label', {}, 'Folder'), folder),
        h('div', { class: 'field' }, h('label', {}, 'Priority'), priority))),
    h('div', { class: 'form-row' },
      h('label', {}, 'Request filter'),
      h('div', {},
        h('div', { class: 'row' }, matchType, pattern),
        hint,
        h('div', { class: 'row', style: 'margin-top:8px' }, testUrl, testResult))),
    h('div', { class: 'form-row' },
      h('label', {}, 'Action'),
      h('div', {}, actionSelect,
        h('p', { class: 'muted small', style: 'margin:5px 0 0' }, RULE_ACTION_HELP[form.action] || ''))),
    h('div', { class: 'form-row' },
      h('label', {}, 'Conditions'),
      h('div', { class: 'cond-grid' },
        h('div', { class: 'field' }, h('label', {}, 'Methods — none means any'), methodChips.node),
        h('div', { class: 'field' }, h('label', {}, 'Resource types — none means any'), typeChips.node),
        h('div', { class: 'field' }, h('label', {}, 'Response status (response stage only)'), statusCodes),
        h('div', { class: 'field' }, h('label', {}, 'Protocol'), protocol),
        h('div', { class: 'field' },
          h('label', {}, 'Options'),
          h('div', { class: 'row' },
            h('label', { class: 'check' }, caseSensitive, ' Case sensitive'),
            h('label', { class: 'check' }, negate, ' Invert match'))))));

  editor.appendChild(h('div', { class: 'editor-inner' }, whenCard, ...stageCards(form, markDirty)));

  function collectDraft() {
    return {
      ...draft,
      name: name.value.trim() || 'Unnamed rule',
      enabled: enabled.checked,
      profile: profile.value.trim() || 'default',
      folder: folder.value.trim(),
      priority: Number(priority.value) || 0,
      actions: form.advanced ? draft.actions : actionsFromForm(form),
      match: {
        ...draft.match,
        urlPattern: pattern.value,
        matchType: matchType.value,
        caseSensitive: caseSensitive.checked,
        negate: negate.checked,
        protocol: protocol.value,
        methods: methodChips.read(),
        resourceTypes: typeChips.read(),
        statusCodes: statusCodes.value.split(',').map((s) => s.trim()).filter(Boolean)
      }
    };
  }
  state.collectDraft = collectDraft;
}

/* ------------------------------------------------- rule form <-> actions */

const RULE_ACTIONS = [
  ['modify', 'Modify request / response'],
  ['mock', 'Mock the response (never hit the network)'],
  ['block', 'Block the request'],
  ['script', 'Run a script'],
  ['advanced', 'Advanced — raw action list']
];

const RULE_ACTION_HELP = {
  modify: 'Rewrite the outgoing request and/or the incoming response.',
  mock: 'Answer immediately with a canned response. The server is never contacted.',
  block: 'Drop the request so the page sees a network error.',
  script: 'Full programmatic control over each exchange.',
  advanced: 'Compose any combination of low-level actions.'
};

const FORM_TYPES = new Set(['redirect', 'set-method', 'set-request-header', 'remove-request-header',
  'set-request-body', 'delay-request', 'delay-response', 'set-status', 'set-response-header',
  'remove-response-header', 'set-response-body']);

function formFromRule(rule) {
  const actions = rule.actions || [];
  const pick = (type) => actions.find((a) => a.type === type) || {};
  const all = (type) => actions.filter((a) => a.type === type);

  const form = {
    ruleId: rule.id,
    action: 'modify',
    advanced: false,
    request: {
      endpoint: pick('redirect').url || '',
      method: pick('set-method').method || '',
      delay: pick('delay-request').ms || '',
      setHeaders: all('set-request-header').map((a) => ({ name: a.name || '', value: a.value || '' })),
      dropHeaders: all('remove-request-header').map((a) => ({ name: a.name || '' })),
      body: {
        bodyType: pick('set-request-body').bodyType || 'text',
        value: pick('set-request-body').value || '',
        enabled: actions.some((a) => a.type === 'set-request-body')
      }
    },
    response: {
      delay: pick('delay-response').ms || '',
      status: pick('set-status').status || '',
      statusMessage: pick('set-status').statusMessage || '',
      setHeaders: all('set-response-header').map((a) => ({ name: a.name || '', value: a.value || '' })),
      dropHeaders: all('remove-response-header').map((a) => ({ name: a.name || '' })),
      body: {
        bodyType: pick('set-response-body').bodyType || 'text',
        value: pick('set-response-body').value || '',
        enabled: actions.some((a) => a.type === 'set-response-body')
      }
    },
    mock: {
      status: pick('mock-response').status || 200,
      bodyType: pick('mock-response').bodyType || 'json',
      value: pick('mock-response').value || '',
      contentType: pick('mock-response').contentType || ''
    },
    block: { reason: pick('cancel').reason || '' },
    script: { code: pick('script').code || SCRIPT_TEMPLATE }
  };

  if (actions.some((a) => a.type === 'cancel')) form.action = 'block';
  else if (actions.some((a) => a.type === 'mock-response')) form.action = 'mock';
  else if (actions.length && actions.every((a) => a.type === 'script')) form.action = 'script';
  else if (actions.some((a) => !FORM_TYPES.has(a.type))) {
    form.action = 'advanced';
    form.advanced = true;
  }
  return form;
}

function actionsFromForm(form) {
  const actions = [];
  if (form.action === 'block') {
    actions.push({ type: 'cancel', reason: form.block.reason || 'Blocked by rule' });
    return actions;
  }
  if (form.action === 'script') {
    actions.push({ type: 'script', code: form.script.code });
    return actions;
  }
  if (form.action === 'mock') {
    actions.push({
      type: 'mock-response',
      status: Number(form.mock.status) || 200,
      bodyType: form.mock.bodyType,
      value: form.mock.value,
      contentType: form.mock.contentType || undefined
    });
    return actions;
  }

  const request = form.request;
  if (request.endpoint.trim()) actions.push({ type: 'redirect', url: request.endpoint.trim() });
  if (request.method) actions.push({ type: 'set-method', method: request.method });
  for (const header of request.setHeaders) {
    if (header.name.trim()) actions.push({ type: 'set-request-header', name: header.name.trim(), value: header.value });
  }
  for (const header of request.dropHeaders) {
    if (header.name.trim()) actions.push({ type: 'remove-request-header', name: header.name.trim() });
  }
  if (request.body.enabled) {
    actions.push({ type: 'set-request-body', bodyType: request.body.bodyType, value: request.body.value });
  }
  if (Number(request.delay) > 0) actions.push({ type: 'delay-request', ms: Number(request.delay) });

  const response = form.response;
  if (Number(response.delay) > 0) actions.push({ type: 'delay-response', ms: Number(response.delay) });
  if (Number(response.status) > 0) {
    actions.push({ type: 'set-status', status: Number(response.status), statusMessage: response.statusMessage || undefined });
  }
  for (const header of response.setHeaders) {
    if (header.name.trim()) actions.push({ type: 'set-response-header', name: header.name.trim(), value: header.value });
  }
  for (const header of response.dropHeaders) {
    if (header.name.trim()) actions.push({ type: 'remove-response-header', name: header.name.trim() });
  }
  if (response.body.enabled) {
    actions.push({ type: 'set-response-body', bodyType: response.body.bodyType, value: response.body.value });
  }
  return actions;
}

/* ------------------------------------------------------- stage rendering */

const MACROS = [
  ['{{url}}', 'Full request URL'],
  ['{{protocol}}', 'http or https'],
  ['{{host}}', 'host with port'],
  ['{{hostname}}', 'host without port'],
  ['{{port}}', 'port'],
  ['{{path}}', 'path only'],
  ['{{query}}', 'query string without ?'],
  ['{{pathAndQuery}}', 'path + query'],
  ['{{method}}', 'request method'],
  ['$1', 'first wildcard / regex capture'],
  ['$2', 'second capture'],
  ['$3', 'third capture']
];

function stageCards(form, markDirty) {
  if (form.action === 'block') {
    const reason = h('input', { class: 'input grow', value: form.block.reason, placeholder: 'Blocked by rule' });
    reason.addEventListener('input', () => { form.block.reason = reason.value; markDirty(); });
    return [h('div', { class: 'card' },
      h('h3', {}, 'Block'),
      h('div', { class: 'form-row' }, h('label', {}, 'Reason'), h('div', {}, reason)))];
  }

  if (form.action === 'script') {
    const code = h('textarea', { class: 'input', style: 'min-height:340px', spellcheck: 'false' }, form.script.code);
    code.addEventListener('input', () => { form.script.code = code.value; markDirty(); });
    return [h('div', { class: 'card' },
      h('h3', {}, 'Script'),
      code,
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', {
          class: 'btn small ghost',
          onclick: async () => {
            const result = await api('/api/script/validate', { method: 'POST', body: { code: form.script.code } });
            toast(result.ok ? 'Script syntax OK' : result.error, !result.ok);
          }
        }, 'Check syntax'),
        h('span', { class: 'muted small' }, 'See the Help tab for the full script API.')))];
  }

  if (form.action === 'mock') {
    const status = numberInput(form.mock.status, '200', (v) => { form.mock.status = v; markDirty(); });
    const contentType = h('input', { class: 'input', value: form.mock.contentType, placeholder: 'application/json' });
    contentType.addEventListener('input', () => { form.mock.contentType = contentType.value; markDirty(); });
    const body = bodyField(form.mock, markDirty);
    return [h('div', { class: 'card' },
      h('h3', {}, 'Mock response'),
      h('div', { class: 'form-row' }, h('label', {}, 'Status code'), h('div', {}, status)),
      h('div', { class: 'form-row' }, h('label', {}, 'Content-Type'), h('div', {}, contentType)),
      h('div', { class: 'form-row' }, h('label', {}, 'Body'), h('div', {}, body)))];
  }

  if (form.advanced) return [advancedCard(form, markDirty)];

  return [requestStage(form, markDirty), responseStage(form, markDirty)];
}

function requestStage(form, markDirty) {
  const request = form.request;

  const endpoint = h('input', {
    class: 'input grow', value: request.endpoint, placeholder: 'Leave empty to keep the original URL'
  });
  endpoint.addEventListener('input', () => { request.endpoint = endpoint.value; markDirty(); });

  const method = h('select', { class: 'input' },
    h('option', { value: '' }, 'Original'),
    ...METHODS.map((m) => h('option', { value: m }, m)));
  method.value = request.method || '';
  method.addEventListener('change', () => { request.method = method.value; markDirty(); });

  const delay = numberInput(request.delay, '0', (v) => { request.delay = v; markDirty(); });
  const setHeaders = headerList(request.setHeaders, true, markDirty);
  const dropHeaders = headerList(request.dropHeaders, false, markDirty);
  const body = bodyField(request.body, markDirty, true);

  return h('div', { class: 'card stage' },
    h('h3', {}, h('span', { class: 'stage-tag' }, 'Stage'), 'Request'),
    h('div', { class: 'form-row' },
      h('label', {}, 'Endpoint'),
      h('div', {},
        h('div', { class: 'row' }, endpoint, macroButton(endpoint, (value) => { request.endpoint = value; markDirty(); })),
        h('p', { class: 'muted small', style: 'margin:5px 0 0' },
          'Redirect matching requests here. Macros and $1 captures are expanded.'))),
    h('div', { class: 'form-row' }, h('label', {}, 'Method'), h('div', {}, method)),
    h('div', { class: 'form-row' }, h('label', {}, 'Set headers'), h('div', {}, setHeaders)),
    h('div', { class: 'form-row' }, h('label', {}, 'Drop headers'), h('div', {}, dropHeaders)),
    h('div', { class: 'form-row' }, h('label', {}, 'Body'), h('div', {}, body)),
    h('div', { class: 'form-row' }, h('label', {}, 'Delay (ms)'), h('div', {}, delay)));
}

function responseStage(form, markDirty) {
  const response = form.response;

  const delay = numberInput(response.delay, '0', (v) => { response.delay = v; markDirty(); });
  const status = numberInput(response.status, 'Original', (v) => { response.status = v; markDirty(); });
  const statusMessage = h('input', { class: 'input', value: response.statusMessage, placeholder: 'Status text (optional)' });
  statusMessage.addEventListener('input', () => { response.statusMessage = statusMessage.value; markDirty(); });
  const setHeaders = headerList(response.setHeaders, true, markDirty);
  const dropHeaders = headerList(response.dropHeaders, false, markDirty);
  const body = bodyField(response.body, markDirty, true);

  return h('div', { class: 'card stage' },
    h('h3', {}, h('span', { class: 'stage-tag' }, 'Stage'), 'Response'),
    h('div', { class: 'form-row' }, h('label', {}, 'Delay (ms)'), h('div', {}, delay)),
    h('div', { class: 'form-row' },
      h('label', {}, 'Status code'),
      h('div', {}, h('div', { class: 'row' }, status, statusMessage))),
    h('div', { class: 'form-row' }, h('label', {}, 'Set headers'), h('div', {}, setHeaders)),
    h('div', { class: 'form-row' }, h('label', {}, 'Drop headers'), h('div', {}, dropHeaders)),
    h('div', { class: 'form-row' }, h('label', {}, 'Body'), h('div', {}, body)));
}

function advancedCard(form, markDirty) {
  const draft = state.draft;
  const actionsBox = h('div');
  const renderActions = () => {
    actionsBox.innerHTML = '';
    if (!draft.actions.length) {
      actionsBox.appendChild(h('p', { class: 'muted small' }, 'No actions yet — pick one below.'));
    }
    draft.actions.forEach((action, index) => {
      actionsBox.appendChild(actionCard(action, index, draft, renderActions, markDirty));
    });
  };
  renderActions();

  const palette = h('div', { class: 'action-palette' },
    ...[['Request actions', true], ['Response actions', false]].map(([title, phase]) =>
      h('div', { class: 'palette-group' },
        h('h4', {}, title),
        h('div', { class: 'palette-grid' },
          ...Object.keys(ACTION_FIELDS)
            .filter((type) => isRequestAction(type) === phase)
            .map((type) => h('button', {
              class: 'palette-item',
              onclick: () => {
                const action = { type };
                if (type === 'script') action.code = SCRIPT_TEMPLATE;
                if (type.includes('body') || type === 'mock-response') action.bodyType = 'text';
                draft.actions.push(action);
                renderActions();
                markDirty();
              }
            }, h('strong', {}, actionLabel(type)), h('small', {}, ACTION_HELP[type] || '')))))));

  return h('div', { class: 'card' },
    h('h3', {}, 'Actions'),
    h('p', { class: 'muted small' }, 'Actions run top to bottom on every matching exchange.'),
    actionsBox,
    palette);
}

function numberInput(value, placeholder, onChange) {
  const input = h('input', {
    class: 'input', type: 'number', min: '0', style: 'max-width:150px',
    value: value === '' || value === undefined ? '' : value,
    placeholder
  });
  input.addEventListener('input', () => onChange(input.value === '' ? '' : Number(input.value)));
  return input;
}

function headerList(rows, withValue, markDirty) {
  const box = h('div', { class: 'hlist' });
  const sync = () => {
    rows.length = 0;
    for (const row of box.children) {
      rows.push({ name: row.children[0].value, value: withValue ? row.children[1].value : '' });
    }
    markDirty();
  };
  const addRow = (name = '', value = '') => {
    const nameInput = h('input', { class: 'input', value: name, placeholder: 'Header name' });
    const valueInput = withValue ? h('input', { class: 'input', value, placeholder: 'Value' }) : null;
    const row = h('div', { class: 'hrow' }, nameInput, valueInput,
      h('button', {
        class: 'btn small ghost danger', title: 'Remove',
        onclick: (event) => { event.preventDefault(); row.remove(); sync(); }
      }, '✕'));
    nameInput.addEventListener('input', sync);
    if (valueInput) valueInput.addEventListener('input', sync);
    box.appendChild(row);
  };
  for (const row of rows) addRow(row.name, row.value);

  return h('div', {}, box,
    h('button', {
      class: 'btn small ghost',
      onclick: (event) => { event.preventDefault(); addRow(); sync(); }
    }, '+ Add'));
}

function bodyField(target, markDirty, optional) {
  const type = h('select', { class: 'input', style: 'max-width:130px' },
    ...BODY_TYPES.map((t) => h('option', { value: t }, t)));
  type.value = target.bodyType || 'text';

  const area = h('textarea', {
    class: 'input', style: 'min-height:150px', spellcheck: 'false',
    placeholder: 'Leave empty to keep the original body'
  }, target.value || '');

  const status = h('span', { class: 'json-status' });
  const validate = () => {
    if (type.value !== 'json' || !area.value.trim()) {
      status.hidden = true;
      return;
    }
    status.hidden = false;
    try {
      JSON.parse(area.value);
      status.className = 'json-status ok';
      status.textContent = 'JSON is valid';
    } catch (err) {
      status.className = 'json-status bad';
      status.textContent = err.message;
    }
  };

  const update = () => {
    target.bodyType = type.value;
    target.value = area.value;
    if (optional) target.enabled = area.value.length > 0;
    validate();
    markDirty();
  };
  type.addEventListener('change', update);
  area.addEventListener('input', update);
  validate();

  return h('div', {},
    h('div', { class: 'row', style: 'margin-bottom:6px' },
      type,
      h('button', {
        class: 'btn small ghost',
        onclick: (event) => {
          event.preventDefault();
          try {
            area.value = JSON.stringify(JSON.parse(area.value), null, 2);
            update();
          } catch {
            toast('Not valid JSON', true);
          }
        }
      }, 'Prettify'),
      status),
    area);
}

function macroButton(input, onInsert) {
  const menu = h('div', { class: 'macro-menu', hidden: true },
    ...MACROS.map(([macro, help]) => h('button', {
      onclick: (event) => {
        event.preventDefault();
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        input.value = input.value.slice(0, start) + macro + input.value.slice(end);
        input.focus();
        input.setSelectionRange(start + macro.length, start + macro.length);
        menu.hidden = true;
        onInsert(input.value);
      }
    }, h('strong', {}, macro), h('small', {}, help))));

  const wrap = h('div', { class: 'macro-wrap' },
    h('button', {
      class: 'btn small ghost',
      onclick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        menu.hidden = !menu.hidden;
      }
    }, 'add macros'),
    menu);

  document.addEventListener('click', (event) => {
    if (!wrap.contains(event.target)) menu.hidden = true;
  });
  return wrap;
}

async function saveDraft() {
  if (!state.draft || !state.collectDraft) return;
  const rule = state.collectDraft();
  try {
    const exists = state.rules.some((r) => r.id === rule.id);
    const data = exists
      ? await api(`/api/rules/${rule.id}`, { method: 'PUT', body: { rule } })
      : await api('/api/rules', { method: 'POST', body: { rule } });
    state.selectedRuleId = data.rule.id;
    state.draft = null;
    state.dirty = false;
    toast('Rule saved');
  } catch (err) {
    toast(err.message, true);
  }
}

function isRequestAction(type) {
  const requestTypes = new Set(['redirect', 'set-method', 'set-request-header', 'add-request-header',
    'remove-request-header', 'set-request-body', 'set-query-param', 'remove-query-param', 'cancel',
    'delay-request', 'mock-response', 'map-local', 'breakpoint-request', 'throttle', 'script']);
  return requestTypes.has(type);
}

function actionLabel(type) {
  if (type === 'cors') return 'CORS headers';
  return type.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function actionSummary(action) {
  switch (action.type) {
    case 'redirect': return action.url || '';
    case 'set-method': return action.method || '';
    case 'set-request-header':
    case 'add-request-header':
    case 'set-response-header':
    case 'add-response-header': return action.name ? `${action.name}: ${action.value || ''}` : '';
    case 'remove-request-header':
    case 'remove-response-header': return action.name || '';
    case 'set-status': return String(action.status || '');
    case 'delay-request':
    case 'delay-response': return action.ms ? `${action.ms} ms` : '';
    case 'throttle': return action.bytesPerSecond ? `${action.bytesPerSecond} B/s` : '';
    case 'map-local': return action.path || '';
    case 'cancel': return action.reason || '';
    case 'mock-response': return `${action.status || 200} · ${action.bodyType || 'text'}`;
    case 'set-request-body':
    case 'set-response-body': return action.bodyType || 'text';
    case 'script': return (action.code || '').split('\n').find((line) => line.trim() && !line.trim().startsWith('//')) || '';
    default: return '';
  }
}

function actionCard(action, index, draft, rerender, markDirty) {
  const fields = ACTION_FIELDS[action.type] || [];
  const summary = h('span', { class: 'action-summary' }, actionSummary(action));
  const body = h('div', { class: 'action-fields' });
  const card = h('div', { class: 'action-card' });

  const stop = (fn) => (event) => {
    event.stopPropagation();
    fn();
  };

  card.appendChild(h('header', {
    onclick: (event) => {
      if (event.target.closest('button')) return;
      card.classList.toggle('collapsed');
    }
  },
    h('strong', {}, actionLabel(action.type)),
    h('span', { class: `phase-tag ${isRequestAction(action.type) ? 'request' : 'response'}` },
      isRequestAction(action.type) ? 'request' : 'response'),
    summary,
    h('button', { class: 'btn small ghost', title: 'Move up', onclick: stop(() => { move(draft.actions, index, -1); markDirty(); rerender(); }) }, '↑'),
    h('button', { class: 'btn small ghost', title: 'Move down', onclick: stop(() => { move(draft.actions, index, 1); markDirty(); rerender(); }) }, '↓'),
    h('button', { class: 'btn small ghost danger', title: 'Remove', onclick: stop(() => { draft.actions.splice(index, 1); markDirty(); rerender(); }) }, '✕')));

  const shortFields = h('div', { class: 'grid2' });
  for (const field of fields) {
    let input;
    let short = true;
    if (field.type === 'select') {
      input = h('select', { class: 'input' }, ...field.options.map((o) => h('option', { value: o }, o)));
      input.value = action[field.k] || field.options[0];
    } else if (field.type === 'textarea' || field.type === 'code') {
      short = false;
      input = h('textarea', {
        class: 'input',
        style: field.type === 'code' ? 'min-height:260px' : 'min-height:120px',
        placeholder: field.ph || '',
        spellcheck: 'false'
      }, action[field.k] || '');
    } else {
      input = h('input', {
        class: 'input grow',
        type: field.type === 'number' ? 'number' : 'text',
        value: action[field.k] === undefined ? '' : action[field.k],
        placeholder: field.ph || ''
      });
    }
    const update = () => {
      action[field.k] = field.type === 'number' ? Number(input.value) : input.value;
      summary.textContent = actionSummary(action);
      markDirty();
    };
    input.addEventListener('input', update);
    input.addEventListener('change', update);
    const wrapped = h('div', { class: 'field' }, h('label', {}, field.label), input);
    if (short) shortFields.appendChild(wrapped);
    else body.appendChild(wrapped);
  }
  if (shortFields.children.length) body.insertBefore(shortFields, body.firstChild);

  if (action.type === 'script') {
    body.appendChild(h('button', {
      class: 'btn small ghost',
      onclick: async () => {
        const result = await api('/api/script/validate', { method: 'POST', body: { code: action.code || '' } });
        toast(result.ok ? 'Script syntax OK' : result.error, !result.ok);
      }
    }, 'Check syntax'));
  }

  card.appendChild(body);
  return card;
}

function move(array, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= array.length) return;
  const [item] = array.splice(index, 1);
  array.splice(target, 0, item);
}

function chipGroup(options, selected, onChange) {
  const chosen = new Set(selected || []);
  const node = h('div', { class: 'chips' });
  for (const option of options) {
    const chip = h('button', {
      class: `chip${chosen.has(option) ? ' on' : ''}`,
      onclick: (event) => {
        event.preventDefault();
        if (chosen.has(option)) chosen.delete(option);
        else chosen.add(option);
        chip.classList.toggle('on', chosen.has(option));
        if (onChange) onChange();
      }
    }, option);
    node.appendChild(chip);
  }
  return { node, read: () => [...chosen] };
}

async function createRule() {
  const rule = {
    name: 'New rule',
    enabled: true,
    match: { urlPattern: '', matchType: 'contains' },
    actions: []
  };
  try {
    const data = await api('/api/rules', { method: 'POST', body: { rule } });
    state.selectedRuleId = data.rule.id;
    state.draft = null;
    state.dirty = false;
    document.querySelector('.tab[data-view="rules"]').click();
  } catch (err) {
    toast(err.message, true);
  }
}

function ruleFromFlow(flow) {
  const rule = {
    name: `Rule for ${flow.host}`,
    enabled: true,
    match: { urlPattern: flow.url.split('?')[0], matchType: 'contains', methods: [flow.method] },
    actions: [{ type: 'set-response-body', bodyType: 'json', value: '{\n  "mocked": true\n}' }]
  };
  api('/api/rules', { method: 'POST', body: { rule } }).then((data) => {
    state.selectedRuleId = data.rule.id;
    state.draft = null;
    state.dirty = false;
    document.querySelector('.tab[data-view="rules"]').click();
    toast('Rule created from this request');
  }).catch((err) => toast(err.message, true));
}

function exportRules() {
  download('netmod-rules.json', JSON.stringify({ rules: state.rules }, null, 2));
}

function importRules() {
  const input = h('input', { type: 'file', accept: 'application/json' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const rules = Array.isArray(parsed) ? parsed : parsed.rules;
      if (!Array.isArray(rules)) throw new Error('File does not contain a rules array');
      await api('/api/rules', { method: 'PUT', body: { rules: [...state.rules, ...rules] } });
      toast(`Imported ${rules.length} rules`);
    } catch (err) {
      toast(err.message, true);
    }
  });
  input.click();
}

/* ----------------------------------------------------------------- settings */

function renderSettings() {
  const panel = el('settingsPanel');
  panel.innerHTML = '';
  const s = state.settings;

  const number = (key, label, hint) => {
    const input = h('input', { class: 'input', type: 'number', value: s[key] });
    input.addEventListener('change', () => patchSettings({ [key]: Number(input.value) }));
    return h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('div', { class: 'muted small' }, hint) : null);
  };
  const toggle = (key, label, hint) => {
    const input = h('input', { type: 'checkbox', checked: !!s[key] });
    input.addEventListener('change', () => patchSettings({ [key]: input.checked }));
    return h('div', { class: 'field' }, h('label', { class: 'check' }, input, ' ', label),
      hint ? h('div', { class: 'muted small' }, hint) : null);
  };

  const filterPattern = h('input', { class: 'input grow', value: s.captureFilter.urlPattern, placeholder: 'only capture URLs containing…' });
  const filterType = h('select', { class: 'input' }, ...['contains', 'wildcard', 'regex'].map((t) => h('option', { value: t }, t)));
  filterType.value = s.captureFilter.matchType;
  const filterMethods = chipGroup(METHODS, s.captureFilter.methods);
  const filterTypes = chipGroup(state.resourceTypes, s.captureFilter.resourceTypes);
  const filterNegate = h('input', { type: 'checkbox', checked: s.captureFilter.negate });

  const bypass = h('textarea', { class: 'input', style: 'min-height:70px' }, (s.bypassHosts || []).join('\n'));
  const upstreamProxy = h('input', { class: 'input', value: s.upstreamProxy || '', placeholder: 'http://user:pass@proxy:8080 or socks5://proxy:1080' });
  const upstreamRoutes = h('textarea', { class: 'input', style: 'min-height:90px', placeholder: '*.internal.test http://proxy:8080' },
    (s.upstreamProxyRoutes || []).map((route) => `${route.pattern} ${route.url}`).join('\n'));
  const bpPattern = h('input', { class: 'input grow', value: (s.breakpoints || {}).urlPattern || '', placeholder: 'only break on URLs containing…' });

  panel.appendChild(h('div', {},
    h('h2', {}, 'Capture filter'),
    h('div', { class: 'card' },
      h('p', { class: 'muted small' }, 'Requests that do not pass this filter are proxied untouched: they are neither shown nor processed by rules.'),
      h('div', { class: 'field' }, h('label', {}, 'URL'), h('div', { class: 'row' }, filterType, filterPattern)),
      h('div', { class: 'field' }, h('label', {}, 'Methods'), filterMethods.node),
      h('div', { class: 'field' }, h('label', {}, 'Resource types'), filterTypes.node),
      h('label', { class: 'check' }, filterNegate, ' Invert (capture everything except matches)'),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', {
          class: 'btn primary',
          onclick: () => patchSettings({
            captureFilter: {
              urlPattern: filterPattern.value,
              matchType: filterType.value,
              methods: filterMethods.read(),
              resourceTypes: filterTypes.read(),
              negate: filterNegate.checked
            }
          })
        }, 'Apply filter'))),

    h('h2', {}, 'Breakpoints'),
    h('div', { class: 'card' },
      toggle('breakpointsEnabled', 'Breakpoints enabled', 'Rules with a breakpoint action also require this.'),
      h('div', { class: 'field' }, h('label', {}, 'Break only on URLs containing'),
        h('div', { class: 'row' }, bpPattern,
          h('button', {
            class: 'btn',
            onclick: () => patchSettings({ breakpoints: { ...s.breakpoints, urlPattern: bpPattern.value } })
          }, 'Save')))),

    h('h2', {}, 'Proxy'),
    h('div', { class: 'card' },
      toggle('interceptHttps', 'Intercept HTTPS (MITM)', 'When off, TLS connections are tunnelled without decryption.'),
      toggle('protectEmailTraffic', 'Protect email traffic from HTTPS interception', 'Tunnels mail ports and common mail or sign-in hosts unchanged. Disable only when you intentionally need to inspect them.'),
      toggle('decodeContentEncoding', 'Decode gzip/deflate/brotli responses', 'Needed to read and edit compressed bodies.'),
      toggle('enableHttp2Upstream', 'Use HTTP/2 upstream when available', 'Negotiates HTTP/2 for direct HTTPS requests and falls back to HTTP/1.1.'),
      toggle('rejectUnauthorized', 'Verify upstream TLS certificates', 'Turn on to refuse invalid upstream certificates.'),
      number('maxBodySize', 'Max buffered body size (bytes)', 'Larger payloads stream through and cannot be modified.'),
      number('maxFlows', 'Max captured requests kept in memory'),
      h('div', { class: 'field' }, h('label', {}, 'Default upstream proxy'), upstreamProxy,
        h('div', { class: 'muted small' }, 'Supports HTTP, HTTPS and SOCKS proxy URLs, including URL-encoded credentials.')),
      h('div', { class: 'field' }, h('label', {}, 'Per-host proxy routes'), upstreamRoutes,
        h('button', {
          class: 'btn', style: 'margin-top:6px',
          onclick: () => patchSettings({
            upstreamProxy: upstreamProxy.value.trim(),
            upstreamProxyRoutes: upstreamRoutes.value.split('\n').map((line) => {
              const space = line.trim().indexOf(' ');
              return space < 0 ? null : { pattern: line.trim().slice(0, space), url: line.trim().slice(space + 1).trim() };
            }).filter((route) => route && route.pattern && route.url)
          })
        }, 'Save upstream routing')),
      h('div', { class: 'field' }, h('label', {}, 'Bypass hosts (one per line, wildcards allowed)'), bypass,
        h('button', {
          class: 'btn',
          style: 'margin-top:6px',
          onclick: () => patchSettings({ bypassHosts: bypass.value.split('\n').map((x) => x.trim()).filter(Boolean) })
        }, 'Save bypass list')),
      h('p', { class: 'muted small' }, `Ports (${s.proxyPort} proxy / ${s.uiPort} UI) change with the --proxy-port and --ui-port flags at startup.`))
  ));
}

/* --------------------------------------------------------------------- help */

function renderHelp() {
  const panel = el('helpPanel');
  const ca = state.ca || {};
  const instructions = state.instructions || {};
  panel.innerHTML = '';
  panel.appendChild(h('div', {},
    h('h2', {}, '1. Trust the root certificate'),
    h('div', { class: 'card' },
      h('p', {}, 'HTTPS interception needs the Network Modifier root CA in your trust store. Everything is generated locally and never leaves your machine.'),
      h('p', { class: 'muted small mono' }, `${ca.path || ''}`),
      h('p', { class: 'muted small mono' }, `SHA-256 ${ca.fingerprintSha256 || ''}`),
      h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: '/api/ca.crt' }, 'Download certificate'),
        h('button', {
          class: 'btn ghost danger',
          onclick: async () => {
            if (!confirm('Regenerate the root CA? You will have to trust the new certificate again.')) return;
            const data = await api('/api/ca/regenerate', { method: 'POST' });
            state.ca = data.ca;
            renderHelp();
            toast('New root CA generated');
          }
        }, 'Regenerate CA')),
      h('h3', {}, 'macOS'), h('ul', {}, ...(instructions.macos || []).map((line) => h('li', { class: 'small' }, line))),
      h('h3', {}, 'Windows'), h('ul', {}, ...(instructions.windows || []).map((line) => h('li', { class: 'small' }, line))),
      h('h3', {}, 'Linux'), h('ul', {}, ...(instructions.linux || []).map((line) => h('li', { class: 'small' }, line)))),

    h('h2', {}, '2. Send traffic through the proxy'),
    h('div', { class: 'card' },
      h('p', {}, `Proxy address: `, h('code', {}, `${state.proxy.host}:${state.proxy.port}`), ' (HTTP and HTTPS)'),
      h('ul', {},
        h('li', {}, 'Whole system: run ', h('code', {}, 'netmod system-proxy on'), ' (and ', h('code', {}, 'netmod system-proxy off'), ' when done).'),
        h('li', {}, 'macOS manually: System Settings → Network → Details → Proxies → Web proxy + Secure web proxy.'),
        h('li', {}, 'Windows manually: Settings → Network & Internet → Proxy → Manual proxy setup.'),
        h('li', {}, 'Chrome/Edge only: ', h('code', {}, `--proxy-server=${state.proxy.host}:${state.proxy.port}`)),
        h('li', {}, 'Firefox only: Settings → Network Settings → Manual proxy configuration (tick "use for HTTPS").'),
        h('li', {}, 'Node/curl: ', h('code', {}, `export HTTP_PROXY=http://${state.proxy.host}:${state.proxy.port} HTTPS_PROXY=http://${state.proxy.host}:${state.proxy.port}`)),
        h('li', {}, 'Mobile devices: set the Wi-Fi proxy to this machine\'s LAN IP and start with ', h('code', {}, '--host 0.0.0.0'), '.'))),

    h('h2', {}, '3. Modify traffic'),
    h('div', { class: 'card' },
      h('ul', {},
        h('li', {}, h('strong', {}, 'Rules'), ' — match by URL, method, resource type or status, then redirect, rewrite headers/bodies, change status codes, delay, throttle, mock or block.'),
        h('li', {}, h('strong', {}, 'Breakpoints'), ' — toggle "Break: req"/"Break: res" in the toolbar, or add a breakpoint action to a rule, then edit the paused exchange by hand.'),
        h('li', {}, h('strong', {}, 'Scripts'), ' — a "Run script" action gives you full programmatic control over each exchange.'),
        h('li', {}, h('strong', {}, 'Replay'), ' — resend any captured request, optionally after editing it.'))),

    h('h2', {}, 'Script API'),
    h('div', { class: 'card' },
      h('pre', { class: 'code' }, `ctx.phase                     'request' | 'response'
ctx.request.method / .url     read + write
ctx.request.headers           object view (read-only)
ctx.request.getHeader(name)
ctx.request.setHeader(n, v) / .addHeader(n, v) / .removeHeader(n)
ctx.request.body              string, assignable
ctx.request.json              parsed JSON, assignable
ctx.request.setQueryParam(n, v)
ctx.request.redirect(url)
ctx.response.status / .statusMessage / .headers / .body / .json
ctx.response.setHeader(n, v) / .removeHeader(n) / .setBodyBase64(b64)
ctx.cancel(reason)            drop the request
ctx.delay(ms)                 extra latency
ctx.throttle(bytesPerSecond)  bandwidth limit
ctx.breakpoint()              pause for manual editing
ctx.mock({ status, headers, body })
vars                          object persisted between script runs
console.log(...)              shown in the terminal running netmod`))
  ));
}

init().catch((err) => {
  document.body.appendChild(h('div', { class: 'toast error' }, `Failed to start UI: ${err.message}`));
});
