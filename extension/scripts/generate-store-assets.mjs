import sharp from 'sharp';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'store-assets');
const icon = await readFile(resolve(root, '..', 'assets', 'network-modifier.svg'));
const screenshot = resolve(output, 'dashboard-1280x800.png');

function tile(width, height, iconSize, headingSize, subheadingSize) {
  const iconX = Math.round(width * 0.09);
  const iconY = Math.round((height - iconSize) / 2);
  const textX = iconX + iconSize + Math.round(width * 0.06);
  const headingY = Math.round(height * 0.48);
  const subheadingY = headingY + Math.round(subheadingSize * 1.75);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#171a1f"/>
    <rect x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" rx="${Math.round(iconSize * 0.19)}" fill="#1468d4"/>
    <path d="M${iconX + iconSize * 0.18} ${iconY + iconSize * 0.5}h${iconSize * 0.18}l${iconSize * 0.11}-${iconSize * 0.14} ${iconSize * 0.12} ${iconSize * 0.28} ${iconSize * 0.1}-${iconSize * 0.14}h${iconSize * 0.13}" fill="none" stroke="#fff" stroke-width="${iconSize * 0.08}" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="${textX}" y="${headingY}" fill="#fff" font-family="Avenir Next, Segoe UI, sans-serif" font-size="${headingSize}" font-weight="700">Network Modifier</text>
    <text x="${textX}" y="${subheadingY}" fill="#aeb5bf" font-family="Avenir Next, Segoe UI, sans-serif" font-size="${subheadingSize}">Inspect and modify frontend API traffic</text>
  </svg>`);
}

await mkdir(output, { recursive: true });
await Promise.all([
  sharp(icon).resize(128, 128).png().toFile(resolve(output, 'store-icon-128.png')),
  sharp(tile(440, 280, 96, 29, 15)).png().toFile(resolve(output, 'small-promo-440x280.png')),
  sharp(tile(1400, 560, 190, 72, 31)).png().toFile(resolve(output, 'marquee-1400x560.png'))
]);

const demoData = `<script>
const traffic = [
  { id: 'req-1', tabId: 42, frameUrl: 'https://shop.example.test', transport: 'fetch', method: 'GET', url: 'https://api.example.test/v1/products', startedAt: Date.now() - 520, duration: 142, status: 200, originalStatus: 200, requestHeaders: { accept: 'application/json' }, requestBody: '', responseHeaders: { 'content-type': 'application/json', 'x-network-modifier': 'modified' }, responseBody: JSON.stringify({ products: [{ id: 101, name: 'Studio Headphones', price: 129, featured: true }, { id: 102, name: 'USB-C Hub', price: 49, featured: false }] }, null, 2), ruleIds: ['rule-1'] },
  { id: 'req-2', tabId: 42, frameUrl: 'https://shop.example.test', transport: 'xhr', method: 'POST', url: 'https://api.example.test/v1/analytics', startedAt: Date.now() - 310, duration: 87, status: 204, originalStatus: 204, requestHeaders: { 'content-type': 'application/json' }, requestBody: '{"event":"product_view"}', responseHeaders: {}, responseBody: '', ruleIds: [] },
  { id: 'req-3', tabId: 42, frameUrl: 'https://shop.example.test', transport: 'fetch', method: 'GET', url: 'https://api.example.test/v1/profile', startedAt: Date.now() - 180, duration: 96, status: 200, originalStatus: 401, requestHeaders: { accept: 'application/json' }, requestBody: '', responseHeaders: { 'content-type': 'application/json' }, responseBody: '{"name":"Demo User","plan":"Pro"}', ruleIds: ['rule-2'] }
];
const settings = { enabled: true, interceptionMode: 'page', tabModes: {}, activeProfiles: ['Development'], networkConditions: { offline: false, latencyMs: 0, downloadKbps: 0, uploadKbps: 0, failureRate: 0 }, trafficLimit: 1000, trafficFilter: '', preserveTraffic: true, rules: [
  { id: 'rule-1', name: 'Enable featured product', enabled: true, urlPattern: '/v1/products', method: 'GET', delayMs: 0, requestBody: '', responseBody: '', responseStatus: 0, error: false, folder: 'Development', profiles: ['Development'] },
  { id: 'rule-2', name: 'Mock signed-in profile', enabled: true, urlPattern: '/v1/profile', method: 'GET', delayMs: 0, requestBody: '', responseBody: '{"name":"Demo User","plan":"Pro"}', responseStatus: 200, error: false, folder: 'Development', profiles: ['Development'] }
] };
const listeners = { addListener() {} };
globalThis.chrome = {
  runtime: { id: 'store-demo', async sendMessage(message) { if (message.type === 'get-traffic') return { traffic }; if (message.type === 'get-breakpoints') return { breakpoints: [] }; if (message.type === 'get-attachment-status') return { attached: true }; return { ok: true }; }, onMessage: listeners },
  storage: { local: { async get(key) { return key === 'settings' ? { settings } : { targetTabId: 42 }; }, async set() {} } },
  tabs: { async query() { return [{ id: 42, title: 'Example Shop - Products', url: 'https://shop.example.test/products' }]; }, async sendMessage() {}, onCreated: listeners, onRemoved: listeners, onUpdated: listeners },
  devtools: { inspectedWindow: { tabId: 0 } }
};
setTimeout(() => document.querySelector('.traffic-row')?.click(), 250);
</script>`;
const panel = await readFile(resolve(root, 'dist', 'panel.html'), 'utf8');
const demo = resolve(output, '.dashboard-demo.html');
await writeFile(demo, panel.replace('<script type="module" src="panel.js"></script>', `${demoData}<script type="module" src="../dist/panel.js"></script>`).replace('href="styles.css"', 'href="../dist/styles.css"'));

const candidates = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'google-chrome',
  'chromium'
].filter(Boolean);
let browser;
for (const candidate of candidates) {
  if (candidate.includes('/')) {
    try { await access(candidate); browser = candidate; break; } catch { continue; }
  }
  if (spawnSync('which', [candidate]).status === 0) { browser = candidate; break; }
}
if (!browser) throw new Error('Chrome or Edge is required to generate the store screenshot. Set CHROME_BIN to its executable.');
const capture = spawnSync(browser, [
  '--headless=new',
  '--allow-file-access-from-files',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1280,800',
  '--virtual-time-budget=1500',
  `--screenshot=${screenshot}`,
  pathToFileURL(demo).href
], { stdio: 'inherit' });
await rm(demo, { force: true });
if (capture.status !== 0) throw new Error(`Chrome screenshot failed with status ${capture.status}`);
const metadata = await sharp(screenshot).metadata();
if (metadata.width !== 1280 || metadata.height !== 800) throw new Error(`Store screenshot is ${metadata.width}x${metadata.height}, expected 1280x800`);
console.log(`Generated Chrome Web Store assets in ${output}`);