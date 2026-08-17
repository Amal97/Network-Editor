import { DEFAULT_SETTINGS, PageConfigMessage, PageTrafficMessage, Settings } from './types';

async function publishSettings() {
  const stored = await chrome.storage.local.get('settings');
  const settings: Settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  const message: PageConfigMessage = { source: 'network-modifier-extension', type: 'config', settings };
  window.postMessage(message, '*');
}

window.addEventListener('message', (event: MessageEvent<PageTrafficMessage | { source: string; type: string }>) => {
  if (event.source !== window || event.data?.source !== 'network-modifier-page') return;
  if (event.data.type === 'config-request') {
    publishSettings();
    return;
  }
  if (event.data.type !== 'traffic' || !('record' in event.data)) return;
  chrome.runtime.sendMessage({ type: 'traffic', record: event.data.record }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'settings-changed') publishSettings();
});

publishSettings();
