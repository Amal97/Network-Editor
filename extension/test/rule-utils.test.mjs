import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCorsDefaults,
  applyJsonEdits,
  diagnoseRules,
  exportRules,
  importRules,
  lineDiff,
  matchRules,
  parseHeaderInput,
  parseJsonEdits,
  prepareFulfilledHeaders,
  trafficToHar
} from '../dist/rule-utils.js';

const rule = {
  id: 'one', name: 'Users', enabled: true, urlPattern: '/api/users', method: 'GET', delayMs: 0,
  requestBody: '', responseBody: '', responseStatus: 400, error: false, folder: 'API', profiles: ['QA']
};

test('matches rules by profile, method, and URL', () => {
  const settings = { enabled: true, rules: [rule], activeProfiles: ['QA'] };
  assert.deepEqual(matchRules(settings, 'https://example.test/api/users', 'GET').map((item) => item.id), ['one']);
  assert.equal(matchRules(settings, 'https://example.test/api/users', 'POST').length, 0);
  assert.equal(matchRules({ ...settings, activeProfiles: ['Production'] }, 'https://example.test/api/users', 'GET').length, 0);
});

test('parses headers and applies nested JSON edits', () => {
  assert.deepEqual(parseHeaderInput('X-Test: yes\nAuthorization: Bearer value'), { 'X-Test': 'yes', Authorization: 'Bearer value' });
  const edits = parseJsonEdits('$.user.name="Changed"\n$.items[0].active=true');
  assert.deepEqual(JSON.parse(applyJsonEdits('{"user":{"name":"Original"},"items":[{"active":false}]}', edits)), { user: { name: 'Changed' }, items: [{ active: true }] });
});

test('prepares decoded replacement bodies for CDP fulfillment', () => {
  const headers = prepareFulfilledHeaders(new Headers({ 'content-encoding': 'gzip', etag: 'old', 'content-type': 'application/json' }), '{"changed":true}');
  assert.equal(headers.get('content-encoding'), null);
  assert.equal(headers.get('etag'), null);
  assert.equal(headers.get('content-length'), String(new TextEncoder().encode('{"changed":true}').byteLength));
  assert.equal(headers.get('x-network-modifier'), 'modified');
});

test('adds credential-safe CORS defaults for synthetic responses', () => {
  const request = new Headers({ origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type', 'access-control-request-private-network': 'true' });
  const headers = applyCorsDefaults(new Headers({ 'content-type': 'application/json' }), request, 'POST');
  assert.equal(headers.get('access-control-allow-origin'), 'https://app.example');
  assert.equal(headers.get('access-control-allow-credentials'), 'true');
  assert.equal(headers.get('access-control-allow-methods'), 'POST');
  assert.equal(headers.get('access-control-allow-headers'), 'authorization, content-type');
  assert.equal(headers.get('access-control-allow-private-network'), 'true');
  assert.equal(headers.get('vary'), 'Origin');
});

test('round trips native exports and diagnoses duplicate matchers', () => {
  const settings = { enabled: true, rules: [rule] };
  assert.equal(importRules(exportRules(settings))[0].responseStatus, 400);
  const warnings = diagnoseRules([rule, { ...rule, id: 'two' }]);
  assert.ok(warnings.some((item) => item.ruleId === 'two' && item.message.includes('Duplicates')));
});

test('imports HAR entries as exact response rules', () => {
  const rules = importRules(JSON.stringify({ log: { entries: [{ request: { method: 'GET', url: 'https://example.test/api?id=1' }, response: { status: 418, content: { text: '{"tea":true}' } } }] } }));
  assert.equal(rules[0].responseStatus, 418);
  assert.equal(rules[0].responseBody, '{"tea":true}');
  assert.match('https://example.test/api?id=1', new RegExp(rules[0].urlPattern));
});

test('exports traffic as HAR and compares response lines', () => {
  const record = { id: 't1', frameUrl: '', transport: 'fetch', method: 'GET', url: 'https://example.test/api', startedAt: 1, duration: 12, status: 200, requestHeaders: {}, requestBody: '', responseHeaders: { 'content-type': 'application/json' }, responseBody: '{"ok":true}', ruleIds: [] };
  const har = JSON.parse(trafficToHar([record]));
  assert.equal(har.log.entries[0].response.status, 200);
  assert.match(lineDiff('one\ntwo', 'one\nthree'), /- two\n\+ three/);
});