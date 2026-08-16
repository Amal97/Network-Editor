'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? error.code : 0, stdout: String(stdout || ''), stderr: String(stderr || error?.message || '') });
    });
  });
}

async function trustCa(certPath, { systemWide = false } = {}) {
  const platform = os.platform();
  if (platform === 'darwin') {
    const keychain = systemWide
      ? '/Library/Keychains/System.keychain'
      : `${os.homedir()}/Library/Keychains/login.keychain-db`;
    const args = ['add-trusted-cert', '-r', 'trustRoot', '-k', keychain, certPath];
    if (systemWide) args.unshift('-d');
    const result = await run('security', args);
    if (!result.ok && systemWide) {
      return { ...result, hint: `Try: sudo security add-trusted-cert -d -r trustRoot -k ${keychain} "${certPath}"` };
    }
    return result;
  }
  if (platform === 'win32') {
    const store = systemWide ? ['-addstore', 'Root'] : ['-addstore', '-user', 'Root'];
    return run('certutil', [...store, certPath]);
  }
  return {
    ok: false,
    stderr: 'Automatic trust is only implemented for macOS and Windows.',
    hint: `sudo cp "${certPath}" /usr/local/share/ca-certificates/network-modifier.crt && sudo update-ca-certificates`
  };
}

async function untrustCa(certPath) {
  const platform = os.platform();
  if (platform === 'darwin') return run('security', ['remove-trusted-cert', certPath]);
  if (platform === 'win32') return run('certutil', ['-delstore', '-user', 'Root', 'Network Modifier Root CA']);
  return { ok: false, stderr: 'Automatic removal is only implemented for macOS and Windows.' };
}

async function listMacNetworkServices() {
  const result = await run('networksetup', ['-listallnetworkservices']);
  return result.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('*'));
}

async function setSystemProxy(enabled, host, port) {
  const platform = os.platform();
  if (platform === 'darwin') {
    const services = await listMacNetworkServices();
    const results = [];
    for (const service of services) {
      if (enabled) {
        results.push(await run('networksetup', ['-setwebproxy', service, host, String(port)]));
        results.push(await run('networksetup', ['-setsecurewebproxy', service, host, String(port)]));
      } else {
        results.push(await run('networksetup', ['-setwebproxystate', service, 'off']));
        results.push(await run('networksetup', ['-setsecurewebproxystate', service, 'off']));
      }
    }
    const failed = results.filter((r) => !r.ok);
    return {
      ok: failed.length === 0,
      stderr: failed.map((r) => r.stderr).join('\n'),
      services,
      hint: failed.length ? 'macOS may require an administrator password; re-run with sudo.' : ''
    };
  }
  if (platform === 'win32') {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    if (enabled) {
      const a = await run('reg', ['add', key, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', `${host}:${port}`, '/f']);
      const b = await run('reg', ['add', key, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
      return { ok: a.ok && b.ok, stderr: [a.stderr, b.stderr].filter(Boolean).join('\n') };
    }
    const off = await run('reg', ['add', key, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
    return off;
  }
  return { ok: false, stderr: 'System proxy toggling is implemented for macOS and Windows only.' };
}

function openBrowser(url) {
  const platform = os.platform();
  const [command, args] = platform === 'darwin'
    ? ['open', [url]]
    : platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* the URL is printed to the console anyway */ }
}

/** Reads the currently configured OS proxy, so the UI can show a real on/off state. */
async function getSystemProxy() {
  const platform = os.platform();
  if (platform === 'darwin') {
    for (const service of await listMacNetworkServices()) {
      const result = await run('networksetup', ['-getwebproxy', service]);
      if (!result.ok) continue;
      const enabled = /^Enabled:\s*Yes/mi.test(result.stdout);
      if (!enabled) continue;
      return {
        enabled: true,
        service,
        host: (/^Server:\s*(.*)$/mi.exec(result.stdout) || [])[1] || '',
        port: (/^Port:\s*(.*)$/mi.exec(result.stdout) || [])[1] || ''
      };
    }
    return { enabled: false };
  }
  if (platform === 'win32') {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const enable = await run('reg', ['query', key, '/v', 'ProxyEnable']);
    const server = await run('reg', ['query', key, '/v', 'ProxyServer']);
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(enable.stdout);
    const address = (/ProxyServer\s+REG_SZ\s+(.*)/i.exec(server.stdout) || [])[1] || '';
    const [host, port] = address.trim().split(':');
    return { enabled, host: host || '', port: port || '' };
  }
  return { enabled: false, unsupported: true };
}

const CHROMIUM_BROWSERS = {
  darwin: [
    { id: 'chrome', name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { id: 'chrome-beta', name: 'Chrome Beta', path: '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta' },
    { id: 'edge', name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { id: 'brave', name: 'Brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
    { id: 'vivaldi', name: 'Vivaldi', path: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi' },
    { id: 'chromium', name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' }
  ],
  win32: [
    { id: 'chrome', name: 'Google Chrome', path: '\\Google\\Chrome\\Application\\chrome.exe' },
    { id: 'edge', name: 'Microsoft Edge', path: '\\Microsoft\\Edge\\Application\\msedge.exe' },
    { id: 'brave', name: 'Brave', path: '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe' }
  ],
  linux: [
    { id: 'chrome', name: 'Google Chrome', path: 'google-chrome' },
    { id: 'chromium', name: 'Chromium', path: 'chromium' },
    { id: 'chromium-browser', name: 'Chromium', path: 'chromium-browser' },
    { id: 'edge', name: 'Microsoft Edge', path: 'microsoft-edge' },
    { id: 'brave', name: 'Brave', path: 'brave-browser' }
  ]
};

/** Chromium browsers found on this machine that can be launched pre-configured. */
function findBrowsers() {
  const platform = os.platform();
  if (platform === 'win32') {
    const roots = [
      process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA
    ].filter(Boolean);
    return CHROMIUM_BROWSERS.win32
      .map((browser) => {
        const found = roots.map((root) => path.join(root, browser.path)).find((p) => fs.existsSync(p));
        return found ? { ...browser, path: found } : null;
      })
      .filter(Boolean);
  }
  if (platform === 'darwin') {
    return CHROMIUM_BROWSERS.darwin.filter((browser) => fs.existsSync(browser.path));
  }
  const seen = new Set();
  return CHROMIUM_BROWSERS.linux.filter((browser) => {
    const found = process.env.PATH.split(':').some((dir) => fs.existsSync(path.join(dir, browser.path)));
    if (!found || seen.has(browser.name)) return false;
    seen.add(browser.name);
    return true;
  });
}

/**
 * Launches a Chromium browser in a throwaway profile that points at the proxy, so no OS-wide
 * setting has to change and the user's normal browsing session is untouched.
 */
function launchBrowser(id, { host, port, url = 'about:blank', normalProfile = false }) {
  const browser = findBrowsers().find((candidate) => candidate.id === id);
  if (!browser) return { ok: false, stderr: `Browser "${id}" was not found on this machine.` };

  const profile = normalProfile ? null : path.join(os.tmpdir(), `netmod-profile-${id}`);
  if (profile) fs.mkdirSync(profile, { recursive: true });
  const args = normalProfile
    ? [url]
    : [
        `--user-data-dir=${profile}`,
        `--proxy-server=http://${host}:${port}`,
        '--proxy-bypass-list=<-loopback>',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-quic',
        url
      ];
  try {
    const child = spawn(browser.path, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return { ok: true, browser: browser.name, profile };
  } catch (err) {
    return { ok: false, stderr: err.message };
  }
}

module.exports = {
  trustCa, untrustCa, setSystemProxy, getSystemProxy, openBrowser, findBrowsers, launchBrowser, run
};
