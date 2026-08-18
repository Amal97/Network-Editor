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

// src/bridge.ts
async function publishSettings() {
  try {
    if (!chrome.runtime?.id) return;
    const stored = await chrome.storage.local.get("settings");
    const settings = { ...DEFAULT_SETTINGS, ...stored.settings || {} };
    const message = { source: "network-modifier-extension", type: "config", settings };
    window.postMessage(message, "*");
  } catch {
  }
}
function sendRuntimeMessage(message) {
  try {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage(message).catch(() => void 0);
  } catch {
  }
}
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "network-modifier-page") return;
  if (event.data.type === "config-request") {
    publishSettings();
    return;
  }
  if (event.data.type !== "traffic" || !("record" in event.data)) return;
  sendRuntimeMessage({ type: "traffic", record: event.data.record });
});
try {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "settings-changed") publishSettings();
  });
} catch {
}
publishSettings().catch(() => void 0);
//# sourceMappingURL=bridge.js.map
