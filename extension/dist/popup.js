// src/types.ts
var DEFAULT_SETTINGS = { enabled: true, rules: [] };

// src/popup.ts
var toggle = document.querySelector("#enabled");
var status = document.querySelector("#status");
var openPanel = document.querySelector("#openDevtools");
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
openPanel.addEventListener("click", () => chrome.tabs.create({ url: "chrome://inspect/#pages" }));
load();
//# sourceMappingURL=popup.js.map
