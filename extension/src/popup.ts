import { DEFAULT_SETTINGS, modeForTab, Settings } from './types';

const toggle = document.querySelector<HTMLInputElement>('#enabled')!;
const status = document.querySelector<HTMLElement>('#status')!;
const openDashboard = document.querySelector<HTMLButtonElement>('#openDashboard')!;

async function load() {
  const stored = await chrome.storage.local.get('settings');
  const settings: Settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  toggle.checked = settings.enabled;
  status.textContent = settings.enabled ? 'Interception enabled' : 'Interception paused';
}

toggle.addEventListener('change', async () => {
  const stored = await chrome.storage.local.get('settings');
  const settings: Settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}), enabled: toggle.checked };
  await chrome.storage.local.set({ settings });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab.id !== undefined && modeForTab(settings, tab.id) === 'full') {
    const result = await chrome.runtime.sendMessage({ type: 'configure-full-mode', tabId: tab.id, enabled: settings.enabled });
    if (!result?.ok) status.textContent = result?.error || 'Could not update Full mode';
  }
  load();
});

openDashboard.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const dashboardUrl = chrome.runtime.getURL('panel.html');
  const [existing] = await chrome.tabs.query({ url: `${dashboardUrl}*` });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true, url: tab.id === undefined ? dashboardUrl : `${dashboardUrl}?tabId=${tab.id}` });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    const query = tab.id === undefined ? '' : `?tabId=${tab.id}`;
    await chrome.tabs.create({ url: `${dashboardUrl}${query}` });
  }
  window.close();
});

load();
