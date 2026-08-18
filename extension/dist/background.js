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
  tabModes: {},
  activeProfiles: ["All"],
  networkConditions: DEFAULT_NETWORK_CONDITIONS,
  trafficLimit: 1e3,
  trafficFilter: "",
  preserveTraffic: true
};
function modeForTab(settings, tabId) {
  return settings.tabModes?.[String(tabId)] || settings.interceptionMode || "page";
}

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
function prepareFulfilledHeaders(headers, body) {
  const output = new Headers(headers);
  for (const name of ["content-encoding", "content-length", "transfer-encoding", "etag", "content-md5"]) output.delete(name);
  output.set("content-length", String(new TextEncoder().encode(body).byteLength));
  output.set("x-network-modifier", "modified");
  return output;
}
function applyCorsDefaults(responseHeaders, requestHeaders, method) {
  const output = new Headers(responseHeaders);
  const origin = requestHeaders.get("origin");
  if (!origin) return output;
  if (!output.has("access-control-allow-origin")) output.set("access-control-allow-origin", origin);
  if (!output.has("access-control-allow-credentials")) output.set("access-control-allow-credentials", "true");
  const requestedMethod = requestHeaders.get("access-control-request-method");
  if (!output.has("access-control-allow-methods")) output.set("access-control-allow-methods", requestedMethod || method);
  const requestedHeaders = requestHeaders.get("access-control-request-headers");
  if (requestedHeaders && !output.has("access-control-allow-headers")) output.set("access-control-allow-headers", requestedHeaders);
  if (requestHeaders.get("access-control-request-private-network") === "true" && !output.has("access-control-allow-private-network")) {
    output.set("access-control-allow-private-network", "true");
  }
  const vary = output.get("vary");
  if (!vary) output.set("vary", "Origin");
  else if (!vary.split(",").some((value) => value.trim().toLowerCase() === "origin")) output.set("vary", `${vary}, Origin`);
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
var requestHeadersById = /* @__PURE__ */ new Map();
var pending = /* @__PURE__ */ new Map();
var trafficHandler = () => void 0;
function onCdpTraffic(handler) {
  trafficHandler = handler;
}
function isFullInterceptionAttached(tabId) {
  return attachedTabs.has(tabId);
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
    await send(tabId, "Network.enable", {
      maxTotalBufferSize: 50 * 1024 * 1024,
      maxResourceBufferSize: 10 * 1024 * 1024,
      maxPostDataSize: 10 * 1024 * 1024,
      enableDurableMessages: true
    });
    await send(tabId, "Network.setCacheDisabled", { cacheDisabled: true });
    await send(tabId, "Network.setBypassServiceWorker", { bypass: true });
    await send(tabId, "Fetch.enable", {
      patterns: [
        { urlPattern: "http://*/*", requestStage: "Request" },
        { urlPattern: "https://*/*", requestStage: "Request" },
        { urlPattern: "http://*/*", requestStage: "Response" },
        { urlPattern: "https://*/*", requestStage: "Response" }
      ]
    });
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
  return configureFullInterception(tabId, settings.enabled && modeForTab(settings, tabId) === "full");
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Fetch.requestPaused" || source.tabId === void 0) return;
  handlePausedRequest(source.tabId, params).catch(() => {
    const event = params;
    const continueMethod = event.responseStatusCode === void 0 ? "Fetch.continueRequest" : "Fetch.continueResponse";
    send(source.tabId, continueMethod, { requestId: event.requestId }).catch(() => void 0);
  });
});
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== void 0) {
    attachedTabs.delete(source.tabId);
    chrome.runtime.sendMessage({ type: "attachment-status-changed", tabId: source.tabId, attached: false }).catch(() => void 0);
  }
});
async function handlePausedRequest(tabId, event) {
  if (!isHttpUrl(event.request.url)) {
    const continueMethod = event.responseStatusCode === void 0 ? "Fetch.continueRequest" : "Fetch.continueResponse";
    await send(tabId, continueMethod, { requestId: event.requestId });
    return;
  }
  const settings = await getSettings();
  const requestHeaders = new Headers(event.request.headers);
  const intendedMethod = event.request.method === "OPTIONS" ? requestHeaders.get("access-control-request-method") || "OPTIONS" : event.request.method;
  const rules = matchRules(settings, event.request.url, intendedMethod);
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
    if (event.request.method === "OPTIONS" && rules.length) {
      const requestHeaders2 = new Headers(event.request.headers);
      const intendedMethod2 = requestHeaders2.get("access-control-request-method") || "OPTIONS";
      const headers3 = prepareFulfilledHeaders(applyCorsDefaults(new Headers(), requestHeaders2, intendedMethod2), "");
      await send(tabId, "Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: 204,
        responsePhrase: responsePhrase(204),
        responseHeaders: headerEntries(headers3),
        body: ""
      });
      return;
    }
    requestStarts.set(event.requestId, Date.now());
    requestHeadersById.set(event.requestId, event.request.headers);
    let postData = event.request.postData || "";
    let headers2 = new Headers(event.request.headers);
    const intendedMethod = event.request.method === "OPTIONS" ? headers2.get("access-control-request-method") || "OPTIONS" : event.request.method;
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
  const needsOriginalBody = rules.some((rule) => rule.responseBody.includes("{{body}}") || Boolean(rule.responseJsonEdits?.length)) || !rules.some((rule) => rule.responseBody);
  let originalBody = "";
  if (needsOriginalBody) {
    const response = await send(tabId, "Fetch.getResponseBody", { requestId: event.requestId });
    originalBody = response.base64Encoded ? fromBase64(response.body) : response.body;
  }
  let body = originalBody;
  let status = event.responseStatusCode;
  let headers = new Headers(Object.fromEntries((event.responseHeaders || []).map(({ name, value }) => [name, value])));
  const requestHeaders = new Headers(requestHeadersById.get(event.requestId) || event.request.headers);
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
    headers = prepareFulfilledHeaders(applyCorsDefaults(headers, requestHeaders, event.request.method), body);
    await send(tabId, "Fetch.fulfillRequest", { requestId: event.requestId, responseCode: status, responsePhrase: responsePhrase(status), responseHeaders: headerEntries(headers), body: toBase64(body) });
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
  clearRequestState(event.requestId);
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
function clearRequestState(requestId) {
  requestStarts.delete(requestId);
  requestBodies.delete(requestId);
  requestHeadersById.delete(requestId);
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
function isHttpUrl(value) {
  return value.startsWith("http://") || value.startsWith("https://");
}
function responsePhrase(status) {
  return (/* @__PURE__ */ new Map([
    [200, "OK"],
    [201, "Created"],
    [202, "Accepted"],
    [204, "No Content"],
    [400, "Bad Request"],
    [401, "Unauthorized"],
    [403, "Forbidden"],
    [404, "Not Found"],
    [409, "Conflict"],
    [422, "Unprocessable Content"],
    [429, "Too Many Requests"],
    [500, "Internal Server Error"],
    [502, "Bad Gateway"],
    [503, "Service Unavailable"]
  ])).get(status) || "Network Modifier";
}
function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// src/background.ts
var trafficByTab = /* @__PURE__ */ new Map();
var currentSettings = DEFAULT_SETTINGS;
onCdpTraffic(storeTraffic);
getSettings2().then((settings) => {
  currentSettings = settings;
});
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
  if (message?.type === "get-effective-settings" && sender.tab?.id !== void 0) {
    getSettings2().then((settings) => sendResponse({ settings: { ...settings, interceptionMode: modeForTab(settings, sender.tab.id) } }));
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
  if (message?.type === "get-attachment-status") {
    sendResponse({ attached: isFullInterceptionAttached(Number(message.tabId)) });
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
    currentSettings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue || {} };
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
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  if (!currentSettings.preserveTraffic) trafficByTab.delete(tabId);
});
function storeTraffic(record) {
  if (record.tabId === void 0) return;
  const traffic = trafficByTab.get(record.tabId) || [];
  const filter = (currentSettings.trafficFilter || "").trim().toLowerCase();
  if (filter && !`${record.method} ${record.url} ${record.status}`.toLowerCase().includes(filter)) return;
  traffic.push(record);
  const limit = Math.max(100, currentSettings.trafficLimit || 1e3);
  if (traffic.length > limit) traffic.splice(0, traffic.length - limit);
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
