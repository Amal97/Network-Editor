#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { NetworkModifier, defaultDataDir } = require('../src'); // eslint-disable-line
const { CertificateAuthority } = require('../src/ca');
const { trustCa, untrustCa, setSystemProxy, disableSystemProxySync, openBrowser, findBrowsers, launchBrowser } = require('../src/platform');
const pkg = require('../package.json');

const HELP = `
Network Modifier ${pkg.version} - a debugging proxy for intercepting and mutating traffic.

Usage
  netmod [start] [options]        Start the proxy and open the web UI
  netmod trust [--system]         Install the root CA into the OS trust store
  netmod untrust                  Remove the root CA from the OS trust store
  netmod cert [--out <file>]      Print or export the root CA certificate path
  netmod system-proxy on|off      Point the OS HTTP/HTTPS proxy at this tool
  netmod --help | --version

Options
  --proxy-port <n>   Proxy listen port           (default 8888)
  --ui-port <n>      Web UI port                 (default 8889)
  --host <addr>      Bind address                (default 127.0.0.1)
  --data-dir <dir>   Config/cert directory       (default ~/.network-modifier)
  --no-open          Do not launch a browser
  --no-https         Disable HTTPS interception (tunnel TLS untouched)
  --browser          Connect the normal browser profile for this run

Quick start
  1. netmod trust            # once, so HTTPS pages do not show certificate errors
  2. netmod                  # starts proxy on 127.0.0.1:8888 and opens the UI
  3. Point your browser/OS at the proxy (or run: netmod system-proxy on)
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name.startsWith('no-')) {
      args.flags[name.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args.flags[name] = true;
    else {
      args.flags[name] = next;
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help || args._[0] === 'help') return console.log(HELP);
  if (args.flags.version) return console.log(pkg.version);

  const dataDir = args.flags['data-dir'] ? path.resolve(String(args.flags['data-dir'])) : defaultDataDir();
  const command = args._[0] || 'start';

  switch (command) {
    case 'start':
      return start(args, dataDir);
    case 'trust':
      return trust(args, dataDir);
    case 'untrust':
      return untrust(dataDir);
    case 'cert':
      return cert(args, dataDir);
    case 'system-proxy':
      return systemProxy(args, dataDir);
    default:
      console.error(`Unknown command "${command}"`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

async function start(args, dataDir) {
  const overrides = {};
  if (args.flags['proxy-port']) overrides.proxyPort = Number(args.flags['proxy-port']);
  if (args.flags['ui-port']) overrides.uiPort = Number(args.flags['ui-port']);
  if (args.flags.host) overrides.host = String(args.flags.host);
  if (args.flags.https === false) overrides.interceptHttps = false;

  const app = new NetworkModifier({ dataDir, overrides });
  let addresses;
  try {
    addresses = await app.start();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port already in use: ${err.message}`);
      console.error('Pick another port with --proxy-port / --ui-port.');
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  console.log(`
  Network Modifier ${pkg.version}

  Proxy      http://${addresses.proxy}
  Web UI     ${addresses.ui}
  Root CA    ${app.ca.caCertPath}
  Data dir   ${dataDir}

  Configure your browser or OS to use ${addresses.proxy} as the HTTP and HTTPS proxy.
  For HTTPS interception without warnings run:  netmod trust
  Press Ctrl+C to stop.
`);

  if (args.flags.browser) {
    const browser = findBrowsers()[0];
    if (browser) {
      const proxyResult = await setSystemProxy(true, app.config.settings.host, app.config.settings.proxyPort);
      if (proxyResult.ok) {
        app.api.systemProxyOwned = true;
        const result = launchBrowser(browser.id, {
          host: app.config.settings.host,
          port: app.config.settings.proxyPort,
          url: addresses.ui,
          normalProfile: true
        });
        if (result.ok) console.log(`  Browser    ${result.browser} (normal profile)`);
        else {
          console.error(`Could not open ${browser.name}: ${result.stderr}`);
          openBrowser(addresses.ui);
        }
      } else {
        console.error(`Could not connect the normal browser: ${proxyResult.stderr.trim()}`);
        console.error(proxyResult.hint || 'Open Connect a browser in the UI to choose another method.');
        openBrowser(addresses.ui);
      }
    } else {
      console.error('No supported Chromium browser was found. Opening the UI in your default browser.');
      console.error('Install Chrome, Edge, Brave, Vivaldi or Chromium for automatic proxy setup.');
      openBrowser(addresses.ui);
    }
  } else if (args.flags.open !== false) {
    openBrowser(addresses.ui);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nStopping...');
    if (app.api.systemProxyOwned) {
      console.log('Restoring the system proxy...');
      await setSystemProxy(false, app.config.settings.host, app.config.settings.proxyPort);
      app.api.systemProxyOwned = false;
    }
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);

  // Without this a crash would leave the OS pointing at a dead proxy, killing all network access.
  process.on('exit', () => {
    if (app.api.systemProxyOwned) {
      app.api.systemProxyOwned = false;
      disableSystemProxySync();
    }
  });
  const crash = (err) => {
    console.error('\nNetwork Modifier hit an unexpected error:');
    console.error(err && err.stack ? err.stack : err);
    if (app.api.systemProxyOwned) console.error('Restoring the system proxy before exiting...');
    process.exit(1);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
}

async function trust(args, dataDir) {
  const ca = new CertificateAuthority(dataDir).init();
  const systemWide = !!args.flags.system;
  console.log(`Installing ${ca.caCertPath} into the ${systemWide ? 'system' : 'current user'} trust store...`);
  const result = await trustCa(ca.caCertPath, { systemWide });
  if (result.ok) {
    console.log('Root certificate trusted. Restart your browser for the change to take effect.');
    console.log('Firefox uses its own certificate store; import the file manually there if needed.');
  } else {
    console.error(result.stderr.trim() || 'Failed to install the certificate.');
    if (result.hint) console.error(result.hint);
    process.exitCode = 1;
  }
}

async function untrust(dataDir) {
  const ca = new CertificateAuthority(dataDir).init();
  const result = await untrustCa(ca.caCertPath);
  console.log(result.ok ? 'Root certificate removed.' : (result.stderr.trim() || 'Failed to remove the certificate.'));
  if (!result.ok) process.exitCode = 1;
}

function cert(args, dataDir) {
  const ca = new CertificateAuthority(dataDir).init();
  if (args.flags.out) {
    const target = path.resolve(String(args.flags.out));
    fs.writeFileSync(target, ca.caCertPem);
    console.log(`Root CA written to ${target}`);
    return;
  }
  const info = ca.info();
  console.log(`Path        ${info.path}`);
  console.log(`Subject     ${info.subject}`);
  console.log(`Valid until ${info.validTo}`);
  console.log(`SHA-256     ${info.fingerprintSha256}`);
}

async function systemProxy(args, dataDir) {
  const mode = String(args._[1] || '').toLowerCase();
  if (mode !== 'on' && mode !== 'off') {
    console.error('Usage: netmod system-proxy on|off');
    process.exitCode = 1;
    return;
  }
  const { Config } = require('../src/config');
  const config = new Config(dataDir).load();
  const host = args.flags.host ? String(args.flags.host) : config.settings.host;
  const port = args.flags['proxy-port'] ? Number(args.flags['proxy-port']) : config.settings.proxyPort;

  const result = await setSystemProxy(mode === 'on', host, port);
  if (result.ok) {
    console.log(mode === 'on'
      ? `System proxy set to ${host}:${port}${result.services ? ` for: ${result.services.join(', ')}` : ''}`
      : 'System proxy disabled.');
  } else {
    console.error(result.stderr.trim() || 'Failed to change the system proxy.');
    if (result.hint) console.error(result.hint);
    if (os.platform() === 'darwin') {
      console.error('You can also change it in System Settings > Network > Details > Proxies.');
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
