'use strict';

const { CertificateAuthority, defaultDataDir } = require('./ca');
const { Config } = require('./config');
const { FlowStore } = require('./store');
const { RuleEngine } = require('./rules');
const { ScriptEngine } = require('./script');
const { BreakpointManager } = require('./breakpoints');
const { ProxyServer } = require('./proxy');
const { ApiServer } = require('./server');

class NetworkModifier {
  constructor({ dataDir = defaultDataDir(), overrides = {} } = {}) {
    this.dataDir = dataDir;
    this.config = new Config(dataDir).load();
    this.config.settings = { ...this.config.settings, ...overrides };

    this.ca = new CertificateAuthority(dataDir).init();
    this.store = new FlowStore({ maxFlows: this.config.settings.maxFlows });
    this.scriptEngine = new ScriptEngine({
      onLog: (entry) => this.api && this.api.log({ level: entry.level, message: entry.args.join(' '), source: 'script' })
    });
    this.ruleEngine = new RuleEngine({ scriptEngine: this.scriptEngine });
    this.ruleEngine.setRules(this.config.rules);
    this.breakpoints = new BreakpointManager();

    this.proxy = new ProxyServer({
      config: this.config,
      ca: this.ca,
      store: this.store,
      ruleEngine: this.ruleEngine,
      breakpoints: this.breakpoints
    });

    this.api = new ApiServer({
      config: this.config,
      ca: this.ca,
      store: this.store,
      proxy: this.proxy,
      ruleEngine: this.ruleEngine,
      breakpoints: this.breakpoints,
      scriptEngine: this.scriptEngine
    });
  }

  async start() {
    const { host } = this.config.settings;
    const proxyAddress = await this.proxy.listen(this.config.settings.proxyPort, host);
    const uiAddress = await this.api.listen(this.config.settings.uiPort, host);
    this.config.settings.proxyPort = proxyAddress.port;
    this.config.settings.uiPort = uiAddress.port;
    return {
      proxy: `${host}:${proxyAddress.port}`,
      ui: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${uiAddress.port}`
    };
  }

  async stop() {
    await Promise.all([this.proxy.close(), this.api.close()]);
  }
}

module.exports = { NetworkModifier, defaultDataDir };
