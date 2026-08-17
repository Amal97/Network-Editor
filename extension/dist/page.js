// src/types.ts
var DEFAULT_SETTINGS = { enabled: true, rules: [] };

// src/page.ts
var settings = DEFAULT_SETTINGS;
var originalFetch = window.fetch.bind(window);
var OriginalXHR = window.XMLHttpRequest;
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "network-modifier-extension" || event.data.type !== "config") return;
  settings = { ...DEFAULT_SETTINGS, ...event.data.settings };
});
window.postMessage({ source: "network-modifier-page", type: "config-request" }, "*");
function matchingRules(url, method) {
  if (!settings.enabled) return [];
  return settings.rules.filter((rule) => {
    if (!rule.enabled || rule.method && rule.method !== "*" && rule.method !== method.toUpperCase()) return false;
    if (!rule.urlPattern) return true;
    try {
      return new RegExp(rule.urlPattern, "i").test(url);
    } catch {
      return url.toLowerCase().includes(rule.urlPattern.toLowerCase());
    }
  });
}
function headersToObject(headers) {
  return Object.fromEntries(headers.entries());
}
function emit(record) {
  window.postMessage({ source: "network-modifier-page", type: "traffic", record }, "*");
}
function id() {
  return `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function applyTemplate(template, original) {
  return template.replaceAll("{{body}}", original);
}
async function readRequestBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return "";
  try {
    return await request.clone().text();
  } catch {
    return "";
  }
}
window.fetch = async (input, init) => {
  const startedAt = Date.now();
  let request = new Request(input, init);
  const rules = matchingRules(request.url, request.method);
  const originalRequestBody = await readRequestBody(request);
  let requestBody = originalRequestBody;
  for (const rule of rules) {
    if (rule.delayMs > 0) await sleep(rule.delayMs);
    if (rule.error) {
      const message = `Blocked by Network Modifier: ${rule.name}`;
      emit({ id: id(), frameUrl: location.href, transport: "fetch", method: request.method, url: request.url, startedAt, duration: Date.now() - startedAt, status: 0, requestHeaders: headersToObject(request.headers), requestBody, responseHeaders: {}, responseBody: "", ruleIds: rules.map((item) => item.id), error: message });
      throw new TypeError(message);
    }
    if (rule.requestBody && !["GET", "HEAD"].includes(request.method)) requestBody = applyTemplate(rule.requestBody, requestBody);
  }
  if (requestBody !== originalRequestBody) {
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    request = new Request(request, { body: requestBody, headers });
  }
  try {
    let response;
    const mockRule = [...rules].reverse().find((rule) => rule.responseBody || rule.responseStatus);
    if (mockRule?.responseBody && mockRule.responseStatus) {
      response = new Response(applyTemplate(mockRule.responseBody, ""), { status: mockRule.responseStatus, headers: { "content-type": "application/json", "x-network-modifier": "mock" } });
    } else {
      response = await originalFetch(request);
    }
    const originalResponseBody = await response.clone().text();
    const originalStatus = response.status;
    let responseBody = originalResponseBody;
    let status = response.status;
    let modified = false;
    for (const rule of rules) {
      if (rule.responseBody) {
        responseBody = applyTemplate(rule.responseBody, responseBody);
        modified = true;
      }
      if (rule.responseStatus) {
        status = rule.responseStatus;
        modified = true;
      }
    }
    const finalResponse = modified ? new Response([204, 205, 304].includes(status) ? null : responseBody, { status, statusText: response.statusText, headers: response.headers }) : response;
    emit({ id: id(), frameUrl: location.href, transport: "fetch", method: request.method, url: request.url, startedAt, duration: Date.now() - startedAt, status, originalStatus, requestHeaders: headersToObject(request.headers), requestBody, responseHeaders: headersToObject(finalResponse.headers), responseBody, ruleIds: rules.map((rule) => rule.id) });
    return finalResponse;
  } catch (error) {
    emit({ id: id(), frameUrl: location.href, transport: "fetch", method: request.method, url: request.url, startedAt, duration: Date.now() - startedAt, status: 0, requestHeaders: headersToObject(request.headers), requestBody, responseHeaders: {}, responseBody: "", ruleIds: rules.map((rule) => rule.id), error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
};
var metadata = /* @__PURE__ */ new WeakMap();
var originalOpen = OriginalXHR.prototype.open;
var originalSend = OriginalXHR.prototype.send;
OriginalXHR.prototype.open = function(method, url, ...rest) {
  const absoluteUrl = new URL(String(url), location.href).href;
  metadata.set(this, { method: method.toUpperCase(), url: absoluteUrl, startedAt: 0, requestBody: "", rules: matchingRules(absoluteUrl, method) });
  this.addEventListener("readystatechange", () => {
    if (this.readyState !== 4) return;
    const meta = metadata.get(this);
    if (!meta) return;
    let responseBody = typeof this.responseText === "string" ? this.responseText : "";
    const originalStatus = this.status;
    let status = originalStatus;
    for (const rule of meta.rules) {
      if (rule.responseBody) responseBody = applyTemplate(rule.responseBody, responseBody);
      if (rule.responseStatus) status = rule.responseStatus;
    }
    try {
      if (responseBody !== this.responseText) {
        Object.defineProperty(this, "responseText", { configurable: true, value: responseBody });
        Object.defineProperty(this, "response", { configurable: true, value: responseBody });
      }
      if (status !== this.status) Object.defineProperty(this, "status", { configurable: true, value: status });
    } catch {
    }
    emit({ id: id(), frameUrl: location.href, transport: "xhr", method: meta.method, url: meta.url, startedAt: meta.startedAt, duration: Date.now() - meta.startedAt, status, originalStatus, requestHeaders: {}, requestBody: meta.requestBody, responseHeaders: parseRawHeaders(this.getAllResponseHeaders()), responseBody, ruleIds: meta.rules.map((rule) => rule.id) });
  });
  return originalOpen.call(this, method, url, ...rest);
};
OriginalXHR.prototype.send = function(body) {
  const meta = metadata.get(this);
  if (!meta) return originalSend.call(this, body);
  meta.startedAt = Date.now();
  meta.requestBody = typeof body === "string" ? body : "";
  for (const rule of meta.rules) if (rule.requestBody) meta.requestBody = applyTemplate(rule.requestBody, meta.requestBody);
  return originalSend.call(this, meta.requestBody || body);
};
function parseRawHeaders(value) {
  const output = {};
  for (const line of value.trim().split(/[\r\n]+/)) {
    const index = line.indexOf(":");
    if (index > 0) output[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return output;
}
//# sourceMappingURL=page.js.map
