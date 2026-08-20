import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const sourceManifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));

test('build emits a complete loadable extension package', () => {
  const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, sourceManifest.version);
  assert.equal(manifest.background.type, 'module');

  const referencedFiles = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.devtools_page,
    ...manifest.content_scripts.flatMap((script) => script.js),
    'panel.html',
    'styles.css',
    'icons/icon.svg',
    ...Object.values(manifest.icons)
  ];
  for (const file of referencedFiles) assert.ok(existsSync(resolve(dist, file)), `Missing dist/${file}`);

  for (const script of ['page.js', 'bridge.js', 'background.js', 'panel.js', 'popup.js', 'devtools.js', 'rule-utils.js']) {
    const source = readFileSync(resolve(dist, script), 'utf8');
    assert.doesNotMatch(source, /^\s*import\s/m, `${script} contains an unbundled import`);
  }
});

test('all extension brand icons come from the canonical asset', () => {
  const canonical = readFileSync(resolve(root, '..', 'assets', 'network-modifier.svg'));
  assert.deepEqual(readFileSync(resolve(dist, 'icons', 'icon.svg')), canonical);
  assert.match(readFileSync(resolve(dist, 'styles.css'), 'utf8'), /url\("icons\/icon\.svg"\)/);
});

test('manifest limits interception to HTTP pages and declares optional full interception support', () => {
  const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  assert.ok(manifest.permissions.includes('debugger'));
  assert.ok(manifest.content_scripts.some((script) => script.world === 'MAIN' && script.run_at === 'document_start'));
});

test('full mode replaces bodies at the response stage with retrievable metadata', () => {
  const background = readFileSync(resolve(dist, 'background.js'), 'utf8');
  assert.match(background, /Network\.setCacheDisabled/);
  assert.match(background, /Network\.setBypassServiceWorker/);
  assert.match(background, /Fetch\.fulfillRequest/);
  assert.match(background, /x-network-modifier/);
  assert.match(background, /maxResourceBufferSize/);
  assert.match(background, /enableDurableMessages: true/);
  assert.match(background, /responsePhrase/);
  assert.match(background, /needsOriginalBody/);
  assert.match(background, /requestHeadersById/);
  assert.doesNotMatch(background, /canFulfillAtRequestStage/);
  assert.match(background, /event\.request\.method === "OPTIONS" && rules\.length/);
  assert.match(background, /responseCode: 204/);
  assert.match(background, /http:\/\/\*\/\*/);
  assert.match(background, /https:\/\/\*\/\*/);
  assert.doesNotMatch(background, /urlPattern:\s*"\*"/);
});

test('panel describes response-stage modification and offers response copying', () => {
  const panel = readFileSync(resolve(dist, 'panel.js'), 'utf8');
  const panelHtml = readFileSync(resolve(dist, 'panel.html'), 'utf8');
  assert.match(panel, /Copy response/);
  assert.match(panel, /Chrome network response stage/);
  assert.doesNotMatch(panel, /Override content/);
  assert.match(panel, /navigator\.clipboard\.writeText/);
  assert.match(panel, /synchronizeInterceptionMode/);
  assert.match(panel, /enabled: fullModeEnabled/);
  assert.match(panel, /GitCompareArrows/);
  assert.match(panel, /Pause interception/);
  assert.match(panel, /formatJsonBody/);
  assert.match(panel, /updateResponseShape/);
  assert.match(panel, /Shape mismatch/);
  assert.match(panelHtml, /Format request body as JSON/);
  assert.match(panelHtml, /Format response body as JSON/);
  assert.match(panelHtml, /Page — JavaScript only/);
  assert.match(panelHtml, /Full — Chrome network/);
  assert.match(panelHtml, /appears in the Network tab/);
});

test('popup opens a standalone Network Modifier dashboard', () => {
  const popup = readFileSync(resolve(dist, 'popup.js'), 'utf8');
  const popupHtml = readFileSync(resolve(dist, 'popup.html'), 'utf8');
  const devtools = readFileSync(resolve(dist, 'devtools.js'), 'utf8');
  const background = readFileSync(resolve(dist, 'background.js'), 'utf8');
  assert.match(popupHtml, /Open Network Modifier/);
  assert.match(popupHtml, /openDashboard/);
  assert.match(popup, /panel\.html/);
  assert.match(popup, /chrome\.tabs\.create/);
  assert.match(popup, /chrome\.tabs\.update/);
  assert.match(readFileSync(resolve(dist, 'panel.html'), 'utf8'), /targetTab/);
  assert.match(readFileSync(resolve(dist, 'panel.js'), 'utf8'), /targetTabId/);
  assert.doesNotMatch(popup, /chrome:\/\/inspect/);
  assert.doesNotMatch(popup, /show-network-modifier/);
  assert.doesNotMatch(devtools, /network-modifier-devtools/);
  assert.doesNotMatch(background, /devtoolsPorts/);
});

test('dashboard supports per-tab modes, retention, live tabs, and attachment status', () => {
  const panel = readFileSync(resolve(dist, 'panel.js'), 'utf8');
  const background = readFileSync(resolve(dist, 'background.js'), 'utf8');
  const panelHtml = readFileSync(resolve(dist, 'panel.html'), 'utf8');
  assert.match(panel, /tabModes/);
  assert.match(panel, /attachment-status-changed/);
  assert.match(panel, /statusTabId !== tabId/);
  assert.match(panel, /Connecting/);
  assert.match(panel, /modeForTab\(settings, previousTabId\)/);
  assert.match(panel, /onCreated\.addListener/);
  assert.match(panel, /Delete rule/);
  assert.match(background, /get-effective-settings/);
  assert.match(background, /trafficFilter/);
  assert.match(panelHtml, /preserveTraffic/);
  assert.match(panelHtml, /connectionStatus/);
});
