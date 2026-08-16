# Network Modifier

A cross-platform debugging proxy that lets you **see, intercept and rewrite** the HTTP/HTTPS
traffic of any browser, app or device — like Fiddler or Charles, but small, scriptable and
driven from a local web UI.

Works on **macOS, Windows and Linux**. Only dependency: Node.js 18+.

![architecture](https://img.shields.io/badge/node-%3E%3D18-informational) ![license](https://img.shields.io/badge/license-MIT-informational)

---

## Install

```bash
cd "Network Modifier"
npm install
npm link          # optional: puts `netmod` on your PATH
```

Or run it without installing globally:

```bash
node bin/netmod.js
```

## No terminal? Just double-click

| OS | File |
| --- | --- |
| macOS | `Start Network Modifier.command` |
| Windows | `Start Network Modifier.bat` |

They install dependencies on first run, start the proxy and open the UI. Everything else —
trusting the certificate, launching a pre-configured browser, toggling the system proxy — is a
button behind **Connect a browser…** in the UI toolbar, so the CLI is entirely optional.

On macOS, the launcher also downloads a verified local copy of Node.js when needed, trusts the
generated certificate on first run, connects the system proxy for the duration of the app, and
opens an installed Chromium browser with its normal profile. The proxy is disabled when Network
Modifier exits, and email traffic remains protected from interception by default.

> macOS may show "unidentified developer" the first time: right-click the `.command` file →
> Open → Open. If Finder opens it in a text editor instead, run `chmod +x "Start Network Modifier.command"` once.

## Quick start

```bash
netmod trust        # 1. trust the locally generated root CA (once)
netmod              # 2. start the proxy + open the web UI
netmod system-proxy on   # 3. (optional) route the whole OS through it
```

* Proxy: `127.0.0.1:8888`
* Web UI: `http://127.0.0.1:8889`
* Config, certificates and rules live in `~/.network-modifier`

When you are done: `netmod system-proxy off`.

### Pointing traffic at the proxy

The **Connect a browser…** button in the UI does all of this for you: it trusts the CA, launches
Chrome/Edge/Brave in a throwaway profile already pointed at the proxy, or flips the system proxy
(and flips it back when you quit). Manual equivalents:

| Target | How |
| --- | --- |
| Whole system | `netmod system-proxy on`, or System Settings → Network → Proxies (macOS) / Settings → Network → Proxy (Windows) |
| Chrome / Edge only | `--proxy-server=127.0.0.1:8888` |
| Firefox | Settings → Network Settings → Manual proxy, tick "Also use this proxy for HTTPS" (import the CA under Certificates → Authorities) |
| curl / Node / Python | `export HTTP_PROXY=http://127.0.0.1:8888 HTTPS_PROXY=http://127.0.0.1:8888` |
| Phone / tablet | Start with `netmod --host 0.0.0.0`, set the Wi‑Fi proxy to your machine's LAN IP, and open `http://<ip>:8889/api/ca.crt` on the device to install the CA |

---

## Features

### Capture
* Full HTTP and HTTPS (MITM) capture with an auto-generated, locally stored root CA.
* Mail ports and common email/authentication hosts bypass HTTPS interception by default, avoiding certificate-pinning and non-HTTP TLS failures.
* Per-host leaf certificates generated on demand and cached.
* WebSocket connections are tunnelled and logged.
* gzip / deflate / brotli / zstd responses are decoded so you can read and edit them.
* Live request list with method, status, URL, resource type, size and duration.
* Inspect request/response headers and bodies, with JSON pretty-printing and image previews.
* Export everything as **HAR**, or copy any request as a **cURL** command.

### Filter
* **Capture filter** (Settings tab) by URL (contains / wildcard / regex), HTTP method and
  resource type (`document`, `stylesheet`, `script`, `image`, `font`, `xhr`, `media`,
  `websocket`, `other`). Anything filtered out is proxied untouched.
* Client-side quick filter for the visible list, plus status-class and "modified only" filters.

### Modify — rules
A rule is edited as a form: **Label**, **Request filter**, **Action**, then two stages.

* **Action** picks what the rule does: *Modify request/response* (the default), *Mock the
  response*, *Block the request*, *Run a script*, or *Advanced* for a raw action list.
* **Stage — Request**: endpoint to redirect to (with macros and `$1` captures), method,
  set headers, drop headers, body, delay.
* **Stage — Response**: delay, status code, set headers, drop headers, body — with live
  `JSON is valid` checking and a Prettify button.
* **Conditions** narrow the filter further: methods, resource types, response status,
  protocol, case sensitivity and invert.
* A **live tester** shows whether a pasted URL matches, including the captured `$1…` values.

Under the hood every rule is still a list of actions, available in *Advanced* mode:

| Phase | Actions |
| --- | --- |
| Request | Redirect to an arbitrary URL · change method · set/add/remove headers · replace body (text, JSON, Base64, form fields, file) · set/remove query params · mock a response without hitting the network · map to a local file · cancel (block) the request · delay before sending · breakpoint |
| Response | Replace status code and text · set/add/remove headers · replace body (text, JSON, Base64, file) · extra delay · bandwidth throttle · CORS helper · breakpoint |
| Both | Run a script |

Values support capture placeholders `$1…$9` (from wildcard/regex matches) and
`{{url}}`, `{{host}}`, `{{path}}`, `{{query}}`, `{{pathAndQuery}}`, `{{method}}`.

Rules can be selected in bulk to enable, disable, duplicate or delete them, and are stored in
`~/.network-modifier/config.json` — exportable/importable as JSON.

### Modify — breakpoints
Toggle **Break: req** / **Break: res** in the toolbar (or add a breakpoint action to a rule).
Matching exchanges pause and a dialog lets you edit the method, URL, every header and the
body — then *Continue with changes*, *Continue unchanged* or *Abort*.

### Modify — scripts
A `Run script` action gives you programmatic control over each exchange:

```js
if (ctx.phase === 'request') {
  if (ctx.request.url.includes('/analytics')) ctx.cancel('no tracking');
  ctx.request.setHeader('Authorization', 'Bearer ' + vars.token);
} else {
  const data = ctx.response.json;
  if (data) { data.featureFlag = true; ctx.response.json = data; }
  ctx.delay(500);
}
```

Available API:

```
ctx.phase                      'request' | 'response'
ctx.request.method/.url        read + write
ctx.request.headers            object view
ctx.request.getHeader/setHeader/addHeader/removeHeader
ctx.request.body               string, assignable
ctx.request.json               parsed JSON, assignable
ctx.request.setQueryParam(n,v) / .redirect(url) / .setBodyBase64(b64)
ctx.response.status/.statusMessage/.headers/.body/.json
ctx.response.setHeader/.addHeader/.removeHeader/.setBodyBase64
ctx.cancel(reason)  ctx.delay(ms)  ctx.throttle(bytesPerSecond)
ctx.breakpoint()    ctx.mock({ status, headers, body })
vars                object persisted between runs
console.log(...)    printed by the netmod process
```

### Replay
Resend any captured request as-is, or open **Edit & replay** to change the method, URL,
headers and body first — optionally re-applying your rules.

---

## CLI

```
netmod [start] [options]        Start the proxy and open the web UI
netmod trust [--system]         Install the root CA into the OS trust store
netmod untrust                  Remove the root CA
netmod cert [--out <file>]      Print or export the root CA
netmod system-proxy on|off      Point the OS HTTP/HTTPS proxy at this tool

  --proxy-port <n>   Proxy port          (default 8888)
  --ui-port <n>      Web UI port         (default 8889)
  --host <addr>      Bind address        (default 127.0.0.1)
  --data-dir <dir>   Config directory    (default ~/.network-modifier)
  --no-open          Do not launch a browser
  --no-https         Tunnel TLS without decrypting it
```

## Local API

The UI is a thin client over a localhost-only JSON API — handy for scripting:

```
GET    /api/state                     settings, proxy info, CA info, rules, action catalog
GET    /api/flows?since=<seq>         captured request summaries
GET    /api/flows/:id                 full request/response detail
GET    /api/flows/:id/body?side=…     raw body download
GET    /api/flows/:id/curl            cURL command
POST   /api/flows/:id/replay          replay (optionally with overrides)
POST   /api/flows/:id/resume|abort    resolve a breakpoint
DELETE /api/flows                     clear the list
GET    /api/flows/har                 HAR export
GET/POST/PUT/DELETE /api/rules[/:id]  rule CRUD
POST   /api/script/validate           syntax-check a script
GET/PATCH /api/settings               settings
GET    /api/ca.crt                    download the root CA
GET    /api/system                    OS proxy state + detected browsers
POST   /api/system/trust              install the root CA into the OS trust store
POST   /api/system/proxy              turn the OS proxy on/off
POST   /api/system/browser            launch a browser pointed at the proxy
GET    /api/events                    server-sent events stream
```

## Project layout

```
bin/netmod.js      CLI entry point
src/ca.js          root CA + on-demand leaf certificates
src/proxy.js       HTTP/HTTPS MITM proxy core
src/rules.js       rule matching + actions
src/script.js      user script execution
src/breakpoints.js pause/resume manager
src/store.js       captured flow store
src/server.js      localhost REST + SSE API and static UI host
public/            the web UI (no build step, no frameworks)
test/smoke.test.js end-to-end tests (`npm test`)
```

## Security notes

* The proxy and the API bind to `127.0.0.1` by default and the API refuses non-local and
  cross-origin callers. Use `--host 0.0.0.0` only on trusted networks.
* The root CA private key stays in `~/.network-modifier` with `0600` permissions. Anyone with
  that key can impersonate any site to your machine — run `netmod untrust` when you are done
  on a shared machine, and `netmod trust` again later.
* Rule scripts run with the privileges of the `netmod` process. Never import rule files from
  sources you do not trust.
* Upstream certificate verification is off by default (so you can debug staging servers with
  self-signed certs). Turn it on in Settings if you want strict verification.

## License

MIT
