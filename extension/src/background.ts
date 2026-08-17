import { DEFAULT_SETTINGS, Settings, TrafficRecord } from './types';

const trafficByTab = new Map<number, TrafficRecord[]>();

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get('settings');
  if (!stored.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'traffic' && sender.tab?.id !== undefined) {
    const record = { ...message.record, tabId: sender.tab.id } as TrafficRecord;
    const traffic = trafficByTab.get(sender.tab.id) || [];
    traffic.push(record);
    if (traffic.length > 1000) traffic.shift();
    trafficByTab.set(sender.tab.id, traffic);
    chrome.runtime.sendMessage({ type: 'traffic', record }).catch(() => undefined);
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
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    chrome.tabs.query({}).then((tabs) => {
      for (const tab of tabs) if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, { type: 'settings-changed' }).catch(() => undefined);
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => trafficByTab.delete(tabId));

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}
