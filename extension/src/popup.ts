import { DEFAULT_SETTINGS, Settings } from './types';

const toggle = document.querySelector<HTMLInputElement>('#enabled')!;
const status = document.querySelector<HTMLElement>('#status')!;
const openPanel = document.querySelector<HTMLButtonElement>('#openDevtools')!;

async function load() {
  const stored = await chrome.storage.local.get('settings');
  const settings: Settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  toggle.checked = settings.enabled;
  status.textContent = settings.enabled ? 'Interception enabled' : 'Interception paused';
}

toggle.addEventListener('change', async () => {
  const stored = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}), enabled: toggle.checked } });
  load();
});

openPanel.addEventListener('click', () => chrome.tabs.create({ url: 'chrome://inspect/#pages' }));
load();
