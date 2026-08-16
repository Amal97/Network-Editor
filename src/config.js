'use strict';

const fs = require('fs');
const path = require('path');
const { defaultDataDir } = require('./ca');
const { makeRule } = require('./rules');

const DEFAULT_SETTINGS = {
  proxyPort: 8888,
  uiPort: 8889,
  host: '127.0.0.1',
  recording: true,
  interceptHttps: true,
  protectEmailTraffic: true,
  maxFlows: 2000,
  maxBodySize: 10 * 1024 * 1024,
  decodeContentEncoding: true,
  enableHttp2Upstream: true,
  rejectUnauthorized: false,
  breakpointsEnabled: true,
  breakpoints: { onRequest: false, onResponse: false, urlPattern: '' },
  captureFilter: { urlPattern: '', matchType: 'contains', methods: [], resourceTypes: [], negate: false },
  activeRuleProfiles: ['default'],
  upstreamProxy: '',
  upstreamProxyRoutes: [],
  bypassHosts: []
};

class Config {
  constructor(dataDir = defaultDataDir()) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'config.json');
    this.settings = { ...DEFAULT_SETTINGS };
    this.rules = [];
    this.snippets = [];
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.settings = {
        ...DEFAULT_SETTINGS,
        ...(raw.settings || {}),
        breakpoints: { ...DEFAULT_SETTINGS.breakpoints, ...(raw.settings || {}).breakpoints },
        captureFilter: { ...DEFAULT_SETTINGS.captureFilter, ...(raw.settings || {}).captureFilter }
      };
      this.rules = (raw.rules || []).map(makeRule);
      this.snippets = raw.snippets || [];
    } catch {
      this.rules = defaultRules();
      this.save();
    }
    return this;
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1,
      settings: this.settings,
      rules: this.rules,
      snippets: this.snippets
    }, null, 2));
    fs.renameSync(tmp, this.file);
    return this;
  }

  updateSettings(patch) {
    this.settings = {
      ...this.settings,
      ...patch,
      breakpoints: { ...this.settings.breakpoints, ...(patch.breakpoints || {}) },
      captureFilter: { ...this.settings.captureFilter, ...(patch.captureFilter || {}) }
    };
    this.save();
    return this.settings;
  }
}

function defaultRules() {
  return [
    makeRule({
      name: 'Example: tag every request',
      enabled: false,
      match: { urlPattern: '', matchType: 'contains' },
      actions: [{ type: 'set-request-header', name: 'X-Debugged-By', value: 'network-modifier' }]
    }),
    makeRule({
      name: 'Example: mock an API endpoint',
      enabled: false,
      match: { urlPattern: '*/api/user*', matchType: 'wildcard' },
      actions: [{
        type: 'mock-response',
        status: 200,
        bodyType: 'json',
        value: '{\n  "id": 1,\n  "name": "Mocked user"\n}'
      }]
    }),
    makeRule({
      name: 'Example: slow down images by 2s',
      enabled: false,
      match: { urlPattern: '', matchType: 'contains', resourceTypes: ['image'] },
      actions: [{ type: 'delay-response', ms: 2000 }]
    })
  ];
}

module.exports = { Config, DEFAULT_SETTINGS };
