// src/types.ts
var DEFAULT_SETTINGS = { enabled: true, rules: [] };

// src/bridge.ts
async function publishSettings() {
  const stored = await chrome.storage.local.get("settings");
  const settings = { ...DEFAULT_SETTINGS, ...stored.settings || {} };
  const message = { source: "network-modifier-extension", type: "config", settings };
  window.postMessage(message, "*");
}
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "network-modifier-page") return;
  if (event.data.type === "config-request") {
    publishSettings();
    return;
  }
  if (event.data.type !== "traffic" || !("record" in event.data)) return;
  chrome.runtime.sendMessage({ type: "traffic", record: event.data.record }).catch(() => void 0);
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "settings-changed") publishSettings();
});
publishSettings();
//# sourceMappingURL=bridge.js.map
