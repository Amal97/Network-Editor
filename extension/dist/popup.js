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
  const settings = { ...DEFAULT_SETTINGS, ...stored.settings || {}, enabled: toggle.checked };
  await chrome.storage.local.set({ settings });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab.id !== void 0 && modeForTab(settings, tab.id) === "full") {
    const result = await chrome.runtime.sendMessage({ type: "configure-full-mode", tabId: tab.id, enabled: settings.enabled });
    if (!result?.ok) status.textContent = result?.error || "Could not update Full mode";
  }
  load();
});
openDashboard.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const dashboardUrl = chrome.runtime.getURL("panel.html");
  const [existing] = await chrome.tabs.query({ url: `${dashboardUrl}*` });
  if (existing?.id !== void 0) {
    await chrome.tabs.update(existing.id, { active: true, url: tab.id === void 0 ? dashboardUrl : `${dashboardUrl}?tabId=${tab.id}` });
    if (existing.windowId !== void 0) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    const query = tab.id === void 0 ? "" : `?tabId=${tab.id}`;
    await chrome.tabs.create({ url: `${dashboardUrl}${query}` });
  }
  window.close();
});
load();
//# sourceMappingURL=popup.js.map
