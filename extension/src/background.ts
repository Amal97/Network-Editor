import { DEFAULT_SETTINGS, modeForTab, Settings, TrafficRecord } from './types';
import { configureFullInterception, continueBreakpoint, getPendingBreakpoints, isFullInterceptionAttached, onCdpTraffic, syncFullMode } from './cdp';

const trafficByTab = new Map<number, TrafficRecord[]>();
let currentSettings: Settings = DEFAULT_SETTINGS;
onCdpTraffic(storeTraffic);
getSettings().then((settings) => { currentSettings = settings; });

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get('settings');
  if (!stored.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'traffic' && sender.tab?.id !== undefined) {
    const record = { ...message.record, tabId: sender.tab.id } as TrafficRecord;
    storeTraffic(record);
    return;
  }
  if (message?.type === 'get-traffic') {
    sendResponse({ traffic: trafficByTab.get(Number(message.tabId)) || [] });
    return true;
  }
  if (message?.type === 'get-effective-settings' && sender.tab?.id !== undefined) {
    getSettings().then((settings) => sendResponse({ settings: { ...settings, interceptionMode: modeForTab(settings, sender.tab!.id!) } }));
    return true;
  }
  if (message?.type === 'clear-traffic') {
    trafficByTab.delete(Number(message.tabId));
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === 'configure-full-mode') {
    configureFullInterception(Number(message.tabId), Boolean(message.enabled)).then(sendResponse);
    return true;
  }
  if (message?.type === 'get-attachment-status') {
    sendResponse({ attached: isFullInterceptionAttached(Number(message.tabId)) });
    return true;
  }
  if (message?.type === 'get-breakpoints') {
    sendResponse({ breakpoints: getPendingBreakpoints(Number(message.tabId)) });
    return true;
  }
  if (message?.type === 'continue-breakpoint') {
    continueBreakpoint(String(message.id)).then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    chrome.tabs.query({}).then((tabs) => {
      for (const tab of tabs) if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, { type: 'settings-changed' }).catch(() => undefined);
    });
    for (const tabId of trafficByTab.keys()) syncFullMode(tabId).catch(() => undefined);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  trafficByTab.delete(tabId);
  configureFullInterception(tabId, false).catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  if (!currentSettings.preserveTraffic) trafficByTab.delete(tabId);
});

function storeTraffic(record: TrafficRecord): void {
  if (record.tabId === undefined) return;
  const traffic = trafficByTab.get(record.tabId) || [];
  const filter = (currentSettings.trafficFilter || '').trim().toLowerCase();
  if (filter && !`${record.method} ${record.url} ${record.status}`.toLowerCase().includes(filter)) return;
  traffic.push(record);
  const limit = Math.max(100, currentSettings.trafficLimit || 1000);
  if (traffic.length > limit) traffic.splice(0, traffic.length - limit);
  trafficByTab.set(record.tabId, traffic);
  chrome.runtime.sendMessage({ type: 'traffic', record }).catch(() => undefined);
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}
