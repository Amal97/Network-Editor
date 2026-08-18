import { DEFAULT_SETTINGS, PageConfigMessage, PageTrafficMessage, Settings } from './types';

async function publishSettings() {
  try {
    if (!chrome.runtime?.id) return;
    const stored = await chrome.storage.local.get('settings');
    const settings: Settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
    const message: PageConfigMessage = { source: 'network-modifier-extension', type: 'config', settings };
    window.postMessage(message, '*');
  } catch {
    // Reloading an unpacked extension invalidates content scripts already in open tabs.
  }
}

function sendRuntimeMessage(message: unknown): void {
  try {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // The page must be reloaded after the unpacked extension is reloaded.
  }
}

window.addEventListener('message', (event: MessageEvent<PageTrafficMessage | { source: string; type: string }>) => {
  if (event.source !== window || event.data?.source !== 'network-modifier-page') return;
  if (event.data.type === 'config-request') {
    publishSettings();
    return;
  }
  if (event.data.type !== 'traffic' || !('record' in event.data)) return;
  sendRuntimeMessage({ type: 'traffic', record: event.data.record });
});

try {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'settings-changed') publishSettings();
  });
} catch {
  // A stale content-script context cannot register extension listeners.
}

publishSettings().catch(() => undefined);
