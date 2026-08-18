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

// src/popup.ts
var toggle = document.querySelector("#enabled");
var status = document.querySelector("#status");
var openDashboard = document.querySelector("#openDashboard");
async function load() {
  const stored = await chrome.storage.local.get("settings");
  const settings = { ...DEFAULT_SETTINGS, ...stored.settings || {} };
  toggle.checked = settings.enabled;
  status.textContent = settings.enabled ? "Interception enabled" : "Interception paused";
}
toggle.addEventListener("change", async () => {
  const stored = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...stored.settings || {}, enabled: toggle.checked } });
  load();
});
openDashboard.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const query = tab.id === void 0 ? "" : `?tabId=${tab.id}`;
  await chrome.tabs.create({ url: chrome.runtime.getURL(`panel.html${query}`) });
  window.close();
});
load();
//# sourceMappingURL=popup.js.map
