import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');

test('build emits a complete loadable extension package', () => {
  const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, 'module');

  const referencedFiles = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.devtools_page,
    ...manifest.content_scripts.flatMap((script) => script.js),
    'panel.html',
    'styles.css'
  ];
  for (const file of referencedFiles) assert.ok(existsSync(resolve(dist, file)), `Missing dist/${file}`);

  for (const script of ['page.js', 'bridge.js', 'background.js', 'panel.js', 'popup.js', 'devtools.js']) {
    const source = readFileSync(resolve(dist, script), 'utf8');
    assert.doesNotMatch(source, /^\s*import\s/m, `${script} contains an unbundled import`);
  }
});

test('manifest limits interception to HTTP pages and avoids debugger permission', () => {
  const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  assert.ok(!manifest.permissions.includes('debugger'));
  assert.ok(manifest.content_scripts.some((script) => script.world === 'MAIN' && script.run_at === 'document_start'));
});
