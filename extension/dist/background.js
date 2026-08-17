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
function matchRules(settings, url, method) {
  if (!settings.enabled) return [];
  const activeProfiles = settings.activeProfiles?.length ? settings.activeProfiles : ["All"];
  return settings.rules.filter((rule) => {
    if (!rule.enabled || !methodMatches(rule, method)) return false;
    if (!activeProfiles.includes("All") && rule.profiles?.length && !rule.profiles.some((profile) => activeProfiles.includes(profile))) return false;
    return urlMatches(rule.urlPattern, url);
  });
}
function urlMatches(pattern, url) {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, "i").test(url);
  } catch {
    return url.toLowerCase().includes(pattern.toLowerCase());
  }
}
function applyHeaders(headers, changes) {
  const output = new Headers(headers);
  for (const [name, value] of Object.entries(changes || {})) {
    if (value === "") output.delete(name);
    else output.set(name, value);
  }
  return output;
}
function applyJsonEdits(body, edits) {
  if (!edits?.length) return body;
  const document = JSON.parse(body);
  for (const edit of edits) setJsonPath(document, edit.path, parseJsonValue(edit.value));
  return JSON.stringify(document, null, 2);
}
function methodMatches(rule, method) {
  return !rule.method || rule.method === "*" || rule.method.toUpperCase() === method.toUpperCase();
}
function parseJsonValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function setJsonPath(document, path, value) {
  const segments = path.replace(/^\$\.?/, "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  if (!segments.length || typeof document !== "object" || document === null) throw new Error(`Invalid JSON path: ${path}`);
  let cursor = document;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== "object" || next === null) cursor[segment] = {};
    cursor = cursor[segment];
  }
  cursor[segments.at(-1)] = value;
}

// src/cdp.ts
var protocolVersion = "1.3";
var attachedTabs = /* @__PURE__ */ new Set();
var requestStarts = /* @__PURE__ */ new Map();
var requestBodies = /* @__PURE__ */ new Map();
var pending = /* @__PURE__ */ new Map();
var trafficHandler = () => void 0;
function onCdpTraffic(handler) {
  trafficHandler = handler;
}
async function configureFullInterception(tabId, enabled) {
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
    await send(tabId, "Network.enable");
    await send(tabId, "Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", requestStage: "Response" }] });
    await applyNetworkConditions(tabId);
    return { ok: true };
  } catch (error) {
    attachedTabs.delete(tabId);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
function getPendingBreakpoints(tabId) {
  return [...pending.entries()].filter(([, item]) => item.tabId === tabId).map(([id, item]) => ({
    id,
    tabId,
    stage: item.stage,
    method: item.event.request.method,
    url: item.event.request.url,
    ruleNames: item.rules.map((rule) => rule.name)
  }));
}
async function continueBreakpoint(id) {
  const item = pending.get(id);
  if (!item) return;
  pending.delete(id);
  await processPausedRequest(item.tabId, item.event, item.rules, true);
  broadcastBreakpoints(item.tabId);
}
async function syncFullMode(tabId) {
  const settings = await getSettings();
  return configureFullInterception(tabId, settings.enabled && settings.interceptionMode === "full");
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Fetch.requestPaused" || source.tabId === void 0) return;
  handlePausedRequest(source.tabId, params).catch(() => {
    const event = params;
    send(source.tabId, "Fetch.continueRequest", { requestId: event.requestId }).catch(() => void 0);
  });
});
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== void 0) attachedTabs.delete(source.tabId);
});
async function handlePausedRequest(tabId, event) {
  const settings = await getSettings();
  const rules = matchRules(settings, event.request.url, event.request.method);
  const stage = event.responseStatusCode === void 0 ? "request" : "response";
  if (rules.some((rule) => stage === "request" ? rule.breakOnRequest : rule.breakOnResponse)) {
    pending.set(event.requestId, { tabId, stage, params: { tabId }, event, rules });
    broadcastBreakpoints(tabId);
    return;
  }
  await processPausedRequest(tabId, event, rules, false);
}
async function processPausedRequest(tabId, event, rules, resumed) {
  if (event.responseStatusCode === void 0) {
    requestStarts.set(event.requestId, Date.now());
    let postData = event.request.postData || "";
    let headers2 = new Headers(event.request.headers);
    for (const rule of rules) {
      if (rule.requestBody) postData = template(rule.requestBody, postData);
      postData = applyJsonEdits(postData, rule.requestJsonEdits);
      headers2 = applyHeaders(headers2, rule.requestHeaders);
    }
    requestBodies.set(event.requestId, postData);
    const conditions = (await getSettings()).networkConditions;
    if (rules.some((rule) => rule.error) || conditions?.offline || Math.random() < (conditions?.failureRate || 0)) {
      await send(tabId, "Fetch.failRequest", { requestId: event.requestId, errorReason: "Failed" });
      return;
    }
    const delay = Math.max(0, ...rules.map((rule) => rule.delayMs || 0));
    if (delay > 0 && !resumed) await wait(delay);
    await send(tabId, "Fetch.continueRequest", {
      requestId: event.requestId,
      headers: headerEntries(headers2),
      ...postData ? { postData: toBase64(postData) } : {}
    });
    return;
  }
  const response = await send(tabId, "Fetch.getResponseBody", { requestId: event.requestId });
  const originalBody = response.base64Encoded ? fromBase64(response.body) : response.body;
  let body = originalBody;
  let status = event.responseStatusCode;
  let headers = new Headers(Object.fromEntries((event.responseHeaders || []).map(({ name, value }) => [name, value])));
  let modified = false;
  for (const rule of rules) {
    if (rule.responseBody) {
      body = template(rule.responseBody, body);
      modified = true;
    }
    if (rule.responseJsonEdits?.length) {
      body = applyJsonEdits(body, rule.responseJsonEdits);
      modified = true;
    }
    if (rule.responseStatus) {
      status = rule.responseStatus;
      modified = true;
    }
    if (rule.responseHeaders && Object.keys(rule.responseHeaders).length) {
      headers = applyHeaders(headers, rule.responseHeaders);
      modified = true;
    }
  }
  if (modified) {
    headers.delete("content-length");
    await send(tabId, "Fetch.fulfillRequest", { requestId: event.requestId, responseCode: status, responseHeaders: headerEntries(headers), body: toBase64(body) });
  } else {
    await send(tabId, "Fetch.continueResponse", { requestId: event.requestId });
  }
  const record = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    tabId,
    frameUrl: "",
    transport: "fetch",
    method: event.request.method,
    url: event.request.url,
    startedAt: requestStarts.get(event.requestId) || Date.now(),
    duration: Date.now() - (requestStarts.get(event.requestId) || Date.now()),
    status,
    originalStatus: event.responseStatusCode,
    requestHeaders: event.request.headers,
    requestBody: requestBodies.get(event.requestId) || event.request.postData || "",
    responseHeaders: Object.fromEntries(headers.entries()),
    responseBody: body,
    ruleIds: rules.map((rule) => rule.id),
    matchedRuleNames: rules.map((rule) => rule.name)
  };
  requestStarts.delete(event.requestId);
  requestBodies.delete(event.requestId);
  trafficHandler(record);
}
async function applyNetworkConditions(tabId) {
  const conditions = (await getSettings()).networkConditions;
  if (!conditions) return;
  await send(tabId, "Network.emulateNetworkConditions", {
    offline: conditions.offline,
    latency: conditions.latencyMs,
    downloadThroughput: conditions.downloadKbps > 0 ? conditions.downloadKbps * 125 : -1,
    uploadThroughput: conditions.uploadKbps > 0 ? conditions.uploadKbps * 125 : -1
  });
}
async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...stored.settings || {} };
}
function broadcastBreakpoints(tabId) {
  chrome.runtime.sendMessage({ type: "breakpoints-changed", tabId }).catch(() => void 0);
}
function headerEntries(headers) {
  return [...headers.entries()].map(([name, value]) => ({ name, value }));
}
function template(value, body) {
  return value.replaceAll("{{body}}", body);
}
function toBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value) {
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// src/background.ts
var trafficByTab = /* @__PURE__ */ new Map();
onCdpTraffic(storeTraffic);
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get("settings");
  if (!stored.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "traffic" && sender.tab?.id !== void 0) {
    const record = { ...message.record, tabId: sender.tab.id };
    storeTraffic(record);
    return;
  }
  if (message?.type === "get-traffic") {
    sendResponse({ traffic: trafficByTab.get(Number(message.tabId)) || [] });
    return true;
  }
  if (message?.type === "clear-traffic") {
    trafficByTab.delete(Number(message.tabId));
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "configure-full-mode") {
    configureFullInterception(Number(message.tabId), Boolean(message.enabled)).then(sendResponse);
    return true;
  }
  if (message?.type === "get-breakpoints") {
    sendResponse({ breakpoints: getPendingBreakpoints(Number(message.tabId)) });
    return true;
  }
  if (message?.type === "continue-breakpoint") {
    continueBreakpoint(String(message.id)).then(() => sendResponse({ ok: true }));
    return true;
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    chrome.tabs.query({}).then((tabs) => {
      for (const tab of tabs) if (tab.id !== void 0) chrome.tabs.sendMessage(tab.id, { type: "settings-changed" }).catch(() => void 0);
    });
    for (const tabId of trafficByTab.keys()) syncFullMode(tabId).catch(() => void 0);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  trafficByTab.delete(tabId);
  configureFullInterception(tabId, false).catch(() => void 0);
});
function storeTraffic(record) {
  if (record.tabId === void 0) return;
  const traffic = trafficByTab.get(record.tabId) || [];
  traffic.push(record);
  if (traffic.length > 1e3) traffic.shift();
  trafficByTab.set(record.tabId, traffic);
  chrome.runtime.sendMessage({ type: "traffic", record }).catch(() => void 0);
}
async function getSettings2() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...stored.settings || {} };
}
export {
  getSettings2 as getSettings
};
//# sourceMappingURL=background.js.map
