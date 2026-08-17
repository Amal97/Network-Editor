import { DEFAULT_SETTINGS, Settings, TrafficRecord } from './types';
import { configureFullInterception, continueBreakpoint, getPendingBreakpoints, onCdpTraffic, syncFullMode } from './cdp';

const trafficByTab = new Map<number, TrafficRecord[]>();
onCdpTraffic(storeTraffic);

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
  if (message?.type === 'clear-traffic') {
    trafficByTab.delete(Number(message.tabId));
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === 'configure-full-mode') {
    configureFullInterception(Number(message.tabId), Boolean(message.enabled)).then(sendResponse);
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

function storeTraffic(record: TrafficRecord): void {
  if (record.tabId === undefined) return;
  const traffic = trafficByTab.get(record.tabId) || [];
  traffic.push(record);
  if (traffic.length > 1000) traffic.shift();
  trafficByTab.set(record.tabId, traffic);
  chrome.runtime.sendMessage({ type: 'traffic', record }).catch(() => undefined);
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}
