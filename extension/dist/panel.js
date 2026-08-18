// src/types.ts
var DEFAULT_NETWORK_CONDITIONS = {
  offline: false,
  latencyMs: 0,
  downloadKbps: 0,
  uploadKbps: 0,
  failureRate: 0
};
var DEFAULT_SETTINGS = {
  enabled: true,
  rules: [],
  interceptionMode: "page",
  activeProfiles: ["All"],
  networkConditions: DEFAULT_NETWORK_CONDITIONS
};

// src/rule-utils.ts
var RESPONSE_PRESETS = [
  { name: "Unauthorized", status: 401, body: '{\n  "error": "Unauthorized"\n}' },
  { name: "Forbidden", status: 403, body: '{\n  "error": "Forbidden"\n}' },
  { name: "Not found", status: 404, body: '{\n  "error": "Not found"\n}' },
  { name: "Rate limited", status: 429, body: '{\n  "error": "Too many requests"\n}' },
  { name: "Server error", status: 500, body: '{\n  "error": "Internal server error"\n}' }
];
var NETWORK_PRESETS = {
  Online: { offline: false, latencyMs: 0, downloadKbps: 0, uploadKbps: 0, failureRate: 0 },
  "Slow 3G": { offline: false, latencyMs: 400, downloadKbps: 400, uploadKbps: 400, failureRate: 0 },
  "Fast 3G": { offline: false, latencyMs: 150, downloadKbps: 1600, uploadKbps: 750, failureRate: 0 },
  Offline: { offline: true, latencyMs: 0, downloadKbps: 0, uploadKbps: 0, failureRate: 1 }
};
function urlMatches(pattern, url) {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, "i").test(url);
  } catch {
    return url.toLowerCase().includes(pattern.toLowerCase());
  }
}
function parseHeaderInput(value) {
  const output = {};
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const index = line.indexOf(":");
    if (index === -1) throw new Error(`Invalid header: ${line}`);
    output[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return output;
}
function formatHeaders(headers) {
  return Object.entries(headers || {}).map(([name, value]) => `${name}: ${value}`).join("\n");
}
function parseJsonEdits(value) {
  if (!value.trim()) return [];
  return value.split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    if (index < 1) throw new Error(`Invalid JSON edit: ${line}`);
    return { path: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
  });
}
function formatJsonEdits(edits) {
  return (edits || []).map((edit) => `${edit.path}=${edit.value}`).join("\n");
}
function diagnoseRules(rules) {
  const diagnostics = [];
  const signatures = /* @__PURE__ */ new Map();
  for (const rule of rules) {
    if (!rule.urlPattern) diagnostics.push({ ruleId: rule.id, severity: "warning", message: "Matches every URL" });
    else {
      try {
        new RegExp(rule.urlPattern);
      } catch {
        diagnostics.push({ ruleId: rule.id, severity: "warning", message: "Pattern is treated as plain text" });
      }
    }
    if (rule.responseStatus && (rule.responseStatus < 100 || rule.responseStatus > 599)) diagnostics.push({ ruleId: rule.id, severity: "error", message: "Status must be between 100 and 599" });
    const signature = `${rule.method}|${rule.urlPattern}|${(rule.profiles || []).sort().join(",")}`;
    const duplicate = signatures.get(signature);
    if (duplicate) diagnostics.push({ ruleId: rule.id, severity: "warning", message: "Duplicates another rule matcher" });
    else signatures.set(signature, rule.id);
  }
  return diagnostics;
}
function exportRules(settings2) {
  return JSON.stringify({ format: "network-modifier", version: 1, settings: settings2 }, null, 2);
}
function importRules(value) {
  const parsed = JSON.parse(value);
  if (Array.isArray(parsed)) return parsed.map(normalizeImportedRule);
  if (parsed?.format === "network-modifier" && Array.isArray(parsed.settings?.rules)) return parsed.settings.rules.map(normalizeImportedRule);
  if (Array.isArray(parsed?.log?.entries)) return parsed.log.entries.map(harEntryToRule).filter((rule) => Boolean(rule));
  const requestlyRules = parsed?.rules || parsed?.items;
  if (Array.isArray(requestlyRules)) return requestlyRules.map(requestlyToRule).filter((rule) => Boolean(rule));
  throw new Error("Unsupported rule file");
}
function harEntryToRule(entry) {
  const request = entry.request;
  const response = entry.response;
  const content = response?.content;
  if (!request?.url) return null;
  return normalizeImportedRule({
    name: `${String(request.method || "*")} ${new URL(String(request.url)).pathname}`,
    method: String(request.method || "*"),
    urlPattern: `^${escapeRegExp(String(request.url))}$`,
    responseStatus: Number(response?.status) || 0,
    responseBody: String(content?.text || ""),
    folder: "HAR import"
  });
}
function trafficToHar(records) {
  return JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "Network Modifier", version: "0.1.0" },
      entries: records.map((record) => ({
        startedDateTime: new Date(record.startedAt).toISOString(),
        time: record.duration,
        request: { method: record.method, url: record.url, httpVersion: "HTTP/1.1", headers: headerEntries(record.requestHeaders), queryString: [], cookies: [], headersSize: -1, bodySize: record.requestBody.length, postData: record.requestBody ? { mimeType: record.requestHeaders["content-type"] || "text/plain", text: record.requestBody } : void 0 },
        response: { status: record.status, statusText: "", httpVersion: "HTTP/1.1", headers: headerEntries(record.responseHeaders), cookies: [], content: { size: record.responseBody.length, mimeType: record.responseHeaders["content-type"] || "text/plain", text: record.responseBody }, redirectURL: "", headersSize: -1, bodySize: record.responseBody.length },
        cache: {},
        timings: { send: 0, wait: record.duration, receive: 0 }
      }))
    }
  }, null, 2);
}
function lineDiff(before, after) {
  const left = before.split("\n");
  const right = after.split("\n");
  const rows = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === right[index]) rows.push(`  ${left[index] ?? ""}`);
    else {
      if (left[index] !== void 0) rows.push(`- ${left[index]}`);
      if (right[index] !== void 0) rows.push(`+ ${right[index]}`);
    }
  }
  return rows.join("\n");
}
function normalizeImportedRule(value) {
  return {
    id: value.id || `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: value.name || "Imported rule",
    enabled: value.enabled !== false,
    urlPattern: value.urlPattern || "",
    method: value.method || "*",
    delayMs: Number(value.delayMs) || 0,
    requestBody: value.requestBody || "",
    responseBody: value.responseBody || "",
    responseStatus: Number(value.responseStatus) || 0,
    error: Boolean(value.error),
    requestHeaders: value.requestHeaders,
    responseHeaders: value.responseHeaders,
    requestJsonEdits: value.requestJsonEdits,
    responseJsonEdits: value.responseJsonEdits,
    breakOnRequest: value.breakOnRequest,
    breakOnResponse: value.breakOnResponse,
    folder: value.folder,
    profiles: value.profiles
  };
}
function requestlyToRule(value) {
  const pairs = value.pairs || value.ruleType === "Response" ? [value] : [];
  const pair = pairs[0] || value;
  const source = pair.source || {};
  const response = pair.response || {};
  const urlPattern = String(source.value || source.url || value.url || "");
  if (!urlPattern) return null;
  return normalizeImportedRule({ name: String(value.name || "Imported Requestly rule"), urlPattern, method: String(source.requestMethod || "*"), responseBody: String(response.value || pair.responseBody || "") });
}
function headerEntries(headers) {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/panel.ts
var tabId = chrome.devtools.inspectedWindow.tabId;
var settings = DEFAULT_SETTINGS;
var traffic = [];
var selectedId = "";
var comparisonIds = /* @__PURE__ */ new Set();
var byId = (id) => document.getElementById(id);
async function runtimeMessage(message) {
  try {
    if (!chrome.runtime?.id) return void 0;
    return await chrome.runtime.sendMessage(message);
  } catch {
    return void 0;
  }
}
function showConnectionError() {
  const status = byId("modeStatus");
  status.hidden = false;
  status.textContent = "Extension context changed. Close DevTools, reload this page, then reopen DevTools.";
}
async function initialize() {
  try {
    const stored = await chrome.storage.local.get("settings");
    settings = { ...DEFAULT_SETTINGS, ...stored.settings || {} };
    traffic = (await runtimeMessage({ type: "get-traffic", tabId }))?.traffic || [];
    wire();
    render();
  } catch {
    wire();
    render();
    showConnectionError();
  }
}
function wire() {
  byId("clear").onclick = async () => {
    await runtimeMessage({ type: "clear-traffic", tabId });
    traffic = [];
    selectedId = "";
    renderTraffic();
  };
  byId("search").oninput = renderTraffic;
  byId("newRule").onclick = () => editRule(newRule());
  byId("mode").onchange = changeMode;
  byId("profile").onchange = async (event) => {
    settings.activeProfiles = [event.target.value];
    await saveSettings();
  };
  byId("network").onclick = showNetworkDialog;
  byId("compare").onclick = showComparison;
  byId("exportRules").onclick = () => download("network-modifier-rules.json", exportRules(settings));
  byId("exportHar").onclick = () => download("network-modifier-traffic.har", trafficToHar(traffic));
  byId("importRules").onclick = () => byId("ruleFile").click();
  byId("ruleFile").onchange = importRuleFile;
  byId("pause").onclick = async () => {
    settings.enabled = !settings.enabled;
    await saveSettings();
  };
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "traffic" && message.record?.tabId === tabId) {
      traffic.push(message.record);
      renderTraffic();
    }
    if (message?.type === "breakpoints-changed" && message.tabId === tabId) renderBreakpoints();
  });
}
function render() {
  byId("pause").textContent = settings.enabled ? "Pause" : "Resume";
  byId("mode").value = settings.interceptionMode || "page";
  renderModeStatus();
  renderProfiles();
  renderTraffic();
  renderRules();
  renderBreakpoints();
}
function renderTraffic() {
  const list = byId("trafficList");
  const query = byId("search").value.toLowerCase();
  list.innerHTML = "";
  const visible = traffic.filter((record) => `${record.method} ${record.url} ${record.status}`.toLowerCase().includes(query));
  byId("count").textContent = `${visible.length} requests`;
  for (const record of [...visible].reverse()) {
    const row = document.createElement("button");
    row.className = `traffic-row${record.id === selectedId ? " selected" : ""}`;
    const modified = record.ruleIds.length > 0 && (record.status !== record.originalStatus || Boolean(record.responseBody));
    row.innerHTML = `<input class="compare-check" type="checkbox" title="Select for comparison" ${comparisonIds.has(record.id) ? "checked" : ""}><span class="method">${escapeHtml(record.method)}</span><span class="status s-${String(record.status)[0]}" title="${modified ? "Response modified" : "Response status"}">${record.error ? "ERR" : record.status}${modified ? "*" : ""}</span><span class="url">${escapeHtml(shortUrl(record.url))}</span><span class="time">${record.duration}ms</span>`;
    row.querySelector("input").onclick = (event) => {
      event.stopPropagation();
      if (event.target.checked) comparisonIds.add(record.id);
      else comparisonIds.delete(record.id);
      if (comparisonIds.size > 2) comparisonIds.delete(comparisonIds.values().next().value);
      renderTraffic();
    };
    row.onclick = () => {
      selectedId = record.id;
      renderTraffic();
      renderDetail(record);
    };
    list.append(row);
  }
  if (!visible.length) list.innerHTML = '<div class="empty">Reload the inspected page to capture XHR and Fetch traffic.</div>';
}
function renderDetail(record) {
  const detail = byId("detail");
  const statusText = record.originalStatus !== void 0 && record.originalStatus !== record.status ? `Server ${record.originalStatus} \u2192 page sees ${record.status}` : `Status ${record.status || record.error || ""}`;
  const modeNote = settings.interceptionMode === "full" ? "Full mode modified this request at the Chrome network response stage." : "Page mode modifications are visible to page JavaScript; Chrome Network shows the server exchange.";
  detail.innerHTML = `<div class="detail-head"><div><strong>${escapeHtml(record.method)} ${escapeHtml(record.url)}</strong><span>${escapeHtml(statusText)} \xB7 ${record.duration}ms</span></div><div><button id="copyResponse">Copy response</button><button id="createFromRequest" class="primary">Create rule</button></div></div>${record.ruleIds.length ? `<div class="modified-note">${escapeHtml(modeNote)}</div>` : ""}${section("Request", record.requestHeaders, record.requestBody)}${section("Modified response", record.responseHeaders, record.responseBody)}${record.ruleIds.length ? `<p class="applied">Rules applied: ${record.ruleIds.length}</p>` : ""}`;
  byId("createFromRequest").onclick = () => editRule(ruleFromTraffic(record));
  byId("copyResponse").onclick = async (event) => {
    await navigator.clipboard.writeText(record.responseBody);
    event.currentTarget.textContent = "Copied";
  };
}
function renderModeStatus() {
  const status = byId("modeStatus");
  status.hidden = true;
  status.textContent = "";
}
function section(title, headers, body) {
  const headerText = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\n");
  return `<section><h3>${title}</h3><pre>${escapeHtml([headerText, body].filter(Boolean).join("\n\n") || "Empty")}</pre></section>`;
}
function renderRules() {
  const list = byId("ruleList");
  list.innerHTML = "";
  const diagnostics = diagnoseRules(settings.rules);
  let currentFolder = "";
  for (const rule of [...settings.rules].sort((left, right) => (left.folder || "Default").localeCompare(right.folder || "Default"))) {
    const folder = rule.folder || "Default";
    if (folder !== currentFolder) {
      currentFolder = folder;
      list.insertAdjacentHTML("beforeend", `<div class="folder-head">${escapeHtml(folder)}</div>`);
    }
    const row = document.createElement("article");
    row.className = `rule-row${rule.enabled ? "" : " disabled"}`;
    const warnings = diagnostics.filter((item) => item.ruleId === rule.id);
    const hits = traffic.filter((record) => record.ruleIds.includes(rule.id)).length;
    if (!hits && traffic.length) warnings.push({ ruleId: rule.id, severity: "warning", message: "No matches in current traffic" });
    row.innerHTML = `<label><input type="checkbox" ${rule.enabled ? "checked" : ""}><span><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(rule.method || "*")} \xB7 ${escapeHtml(rule.urlPattern || "all URLs")}</small><small>${hits} hit${hits === 1 ? "" : "s"}${warnings.length ? ` \xB7 <span class="warning" title="${escapeHtml(warnings.map((item) => item.message).join("; "))}">${warnings.length} warning${warnings.length === 1 ? "" : "s"}</span>` : ""}</small></span></label><button>Edit</button>`;
    row.querySelector("input").onchange = async (event) => {
      rule.enabled = event.target.checked;
      await saveSettings();
    };
    row.querySelector("button").onclick = () => editRule(rule);
    list.append(row);
  }
  if (!settings.rules.length) list.innerHTML = '<div class="empty compact">No rules yet. Create one to modify an API call.</div>';
}
function editRule(rule) {
  const dialog = byId("ruleDialog");
  byId("ruleName").value = rule.name;
  byId("ruleMethod").value = rule.method;
  byId("ruleUrl").value = rule.urlPattern;
  byId("ruleDelay").value = String(rule.delayMs || 0);
  byId("requestBody").value = rule.requestBody;
  byId("responseBody").value = rule.responseBody;
  byId("responseStatus").value = String(rule.responseStatus || 0);
  byId("ruleError").checked = rule.error;
  byId("ruleFolder").value = rule.folder || "";
  byId("ruleProfiles").value = (rule.profiles || []).join(", ");
  byId("requestHeaders").value = formatHeaders(rule.requestHeaders);
  byId("responseHeaders").value = formatHeaders(rule.responseHeaders);
  byId("requestJsonEdits").value = formatJsonEdits(rule.requestJsonEdits);
  byId("responseJsonEdits").value = formatJsonEdits(rule.responseJsonEdits);
  byId("breakRequest").checked = Boolean(rule.breakOnRequest);
  byId("breakResponse").checked = Boolean(rule.breakOnResponse);
  populatePresets();
  updateMatchPreview();
  byId("ruleUrl").oninput = updateMatchPreview;
  byId("deleteRule").hidden = !settings.rules.some((item) => item.id === rule.id);
  byId("saveRule").onclick = async () => {
    try {
      rule.name = byId("ruleName").value.trim() || "Untitled rule";
      rule.method = byId("ruleMethod").value;
      rule.urlPattern = byId("ruleUrl").value.trim();
      rule.delayMs = Number(byId("ruleDelay").value) || 0;
      rule.requestBody = byId("requestBody").value;
      rule.responseBody = byId("responseBody").value;
      rule.responseStatus = Number(byId("responseStatus").value) || 0;
      rule.error = byId("ruleError").checked;
      rule.folder = byId("ruleFolder").value.trim() || "Default";
      rule.profiles = byId("ruleProfiles").value.split(",").map((value) => value.trim()).filter(Boolean);
      rule.requestHeaders = parseHeaderInput(byId("requestHeaders").value);
      rule.responseHeaders = parseHeaderInput(byId("responseHeaders").value);
      rule.requestJsonEdits = parseJsonEdits(byId("requestJsonEdits").value);
      rule.responseJsonEdits = parseJsonEdits(byId("responseJsonEdits").value);
      rule.breakOnRequest = byId("breakRequest").checked;
      rule.breakOnResponse = byId("breakResponse").checked;
      if (!settings.rules.some((item) => item.id === rule.id)) settings.rules.push(rule);
      await saveSettings();
      dialog.close();
    } catch (error) {
      byId("matchPreview").textContent = error instanceof Error ? error.message : String(error);
      byId("matchPreview").className = "match-preview error";
    }
  };
  byId("deleteRule").onclick = async () => {
    settings.rules = settings.rules.filter((item) => item.id !== rule.id);
    await saveSettings();
    dialog.close();
  };
  byId("cancelRule").onclick = () => dialog.close();
  dialog.showModal();
}
async function saveSettings() {
  await chrome.storage.local.set({ settings });
  await chrome.tabs.sendMessage(tabId, { type: "settings-changed" }).catch(() => void 0);
  if (settings.interceptionMode === "full") await runtimeMessage({ type: "configure-full-mode", tabId, enabled: settings.enabled });
  render();
}
async function changeMode(event) {
  const mode = event.target.value;
  const result = await runtimeMessage({ type: "configure-full-mode", tabId, enabled: mode === "full" });
  const status = byId("modeStatus");
  if (!result) {
    showConnectionError();
    return;
  }
  status.hidden = result.ok;
  status.textContent = result.error || "";
  if (!result.ok) {
    byId("mode").value = settings.interceptionMode || "page";
    return;
  }
  settings.interceptionMode = mode;
  await saveSettings();
}
function renderProfiles() {
  const select = byId("profile");
  const profiles = /* @__PURE__ */ new Set(["All", ...settings.rules.flatMap((rule) => rule.profiles || [])]);
  select.innerHTML = [...profiles].map((profile) => `<option>${escapeHtml(profile)}</option>`).join("");
  select.value = settings.activeProfiles?.[0] || "All";
}
function updateMatchPreview() {
  const pattern = byId("ruleUrl").value;
  const matches = traffic.filter((record) => urlMatches(pattern, record.url)).length;
  byId("matchPreview").className = "match-preview";
  byId("matchPreview").textContent = `Matches ${matches} captured request${matches === 1 ? "" : "s"}`;
}
function populatePresets() {
  const select = byId("responsePreset");
  select.innerHTML = '<option value="">Custom</option>' + RESPONSE_PRESETS.map((preset) => `<option value="${preset.status}">${preset.status} ${escapeHtml(preset.name)}</option>`).join("");
  select.onchange = () => {
    const preset = RESPONSE_PRESETS.find((item) => item.status === Number(select.value));
    if (!preset) return;
    byId("responseStatus").value = String(preset.status);
    byId("responseBody").value = preset.body;
  };
}
async function renderBreakpoints() {
  const container = byId("breakpoints");
  const response = await runtimeMessage({ type: "get-breakpoints", tabId });
  const breakpoints = response?.breakpoints || [];
  container.hidden = !breakpoints.length;
  container.innerHTML = breakpoints.map((item) => `<span>Paused ${escapeHtml(item.stage)}: ${escapeHtml(item.method)} ${escapeHtml(shortUrl(item.url))}</span><button data-id="${escapeHtml(item.id)}">Continue</button>`).join("");
  container.querySelectorAll("button").forEach((button) => button.onclick = async () => {
    await runtimeMessage({ type: "continue-breakpoint", id: button.dataset.id });
    renderBreakpoints();
  });
}
function showNetworkDialog() {
  const dialog = byId("networkDialog");
  const conditions = settings.networkConditions || DEFAULT_NETWORK_CONDITIONS;
  const preset = byId("networkPreset");
  preset.innerHTML = Object.keys(NETWORK_PRESETS).map((name) => `<option>${name}</option>`).join("") + "<option>Custom</option>";
  const fill = () => {
    byId("latency").value = String(conditions.latencyMs);
    byId("failureRate").value = String(conditions.failureRate * 100);
    byId("downloadKbps").value = String(conditions.downloadKbps);
    byId("uploadKbps").value = String(conditions.uploadKbps);
    byId("offline").checked = conditions.offline;
  };
  fill();
  preset.onchange = () => {
    const value = NETWORK_PRESETS[preset.value];
    if (value) Object.assign(conditions, value);
    fill();
  };
  byId("cancelNetwork").onclick = () => dialog.close();
  byId("saveNetwork").onclick = async () => {
    settings.networkConditions = { offline: byId("offline").checked, latencyMs: Number(byId("latency").value) || 0, failureRate: (Number(byId("failureRate").value) || 0) / 100, downloadKbps: Number(byId("downloadKbps").value) || 0, uploadKbps: Number(byId("uploadKbps").value) || 0 };
    await saveSettings();
    dialog.close();
  };
  dialog.showModal();
}
function showComparison() {
  const records = [...comparisonIds].map((id) => traffic.find((record) => record.id === id)).filter((record) => Boolean(record));
  if (records.length !== 2) {
    byId("modeStatus").hidden = false;
    byId("modeStatus").textContent = "Select exactly two traffic checkboxes to compare.";
    return;
  }
  byId("comparison").textContent = `--- ${records[0].method} ${records[0].url}
+++ ${records[1].method} ${records[1].url}
${lineDiff(records[0].responseBody, records[1].responseBody)}`;
  const dialog = byId("compareDialog");
  byId("closeCompare").onclick = () => dialog.close();
  dialog.showModal();
}
async function importRuleFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    settings.rules.push(...importRules(await file.text()));
    await saveSettings();
  } catch (error) {
    byId("modeStatus").hidden = false;
    byId("modeStatus").textContent = error instanceof Error ? error.message : String(error);
  }
  event.target.value = "";
}
function download(filename, contents) {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
function newRule() {
  return { id: `r${Date.now().toString(36)}`, name: "New API rule", enabled: true, urlPattern: "", method: "*", delayMs: 0, requestBody: "", responseBody: "", responseStatus: 0, error: false };
}
function ruleFromTraffic(record) {
  const url = new URL(record.url);
  return {
    ...newRule(),
    name: `${record.method} ${url.pathname}`,
    method: record.method,
    urlPattern: `^${escapeRegExp2(record.url)}$`,
    requestBody: record.requestBody,
    responseBody: record.responseBody,
    responseStatus: record.status
  };
}
function escapeRegExp2(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function shortUrl(value) {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
initialize().catch(showConnectionError);
//# sourceMappingURL=panel.js.map
