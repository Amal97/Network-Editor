# Network Modifier

A standalone Manifest V3 Chrome extension for monitoring and modifying frontend XHR and Fetch traffic. It does not require the Network Modifier proxy or a trusted certificate.

## Current capabilities

- Open a standalone dashboard and select the browser tab to inspect
- Capture Fetch and XMLHttpRequest traffic from selected tabs
- Optional **Full mode** uses Chrome DevTools Protocol so the page receives wire-level response replacements
- Inspect request/response bodies, status, headers, timing, matched rules, and original versus modified status
- Match rules by HTTP method and URL text or regular expression
- Replace request and response bodies (`{{body}}` inserts the previous body)
- Add/remove request and response headers (an empty value removes a header)
- Edit nested JSON fields with paths such as `$.user.name="Test"`
- Override response status, add delay, simulate failures, and return mock responses
- Pause matching requests or responses and continue them from the panel in Full mode
- Apply common response presets (`401`, `403`, `404`, `429`, and `500`)
- Organize rules into folders and activate named profiles
- Preview how many captured calls a rule matches and see hit/conflict diagnostics
- Import Network Modifier, Requestly-style JSON, or HAR files; export rules or captured traffic as HAR
- Simulate latency, bandwidth, offline mode, and random failures
- Select two captured calls and compare response bodies
- Store settings and rules locally with `chrome.storage.local`
- Cap and filter captured traffic or preserve it across navigation

## Build and load

```sh
npm install
npm run build
```

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the generated `dist/` directory.
4. Pin Network Modifier, open its popup, and choose **Open Network Modifier**.
5. Select a target tab in the dashboard and reload that tab so interception starts at `document_start`.

The dashboard is the primary interface. A Network Modifier DevTools panel remains available as an alternative.

Use **Page mode** for lightweight Fetch/XHR modification. Use **Full mode** when the page must consume a wire-level replacement. Chrome displays an automation/debugging banner while Full mode is attached.

Response replacement rules wait for the upstream response headers and then fulfill the paused response, matching the response-mutation architecture used by Netify. Static replacement bodies skip downloading the original body; `{{body}}` templates and JSON edits retrieve it first. **Copy response** remains available for transferring a captured body elsewhere.

Use `npm run watch` while developing, then click Reload on the extension card after changes.

## Release package

```sh
npm run package
```

This rebuilds, typechecks, tests, and creates `releases/network-modifier-v1.0.0.zip`. See [PRIVACY.md](PRIVACY.md) for the data-handling policy.

## Troubleshooting

- Reload target pages after reloading the unpacked extension.
- If Full mode says disconnected, close other tools using Chrome's debugger for that tab and select Full mode again.
- Full mode displays Chrome's debugging banner while attached.
- Keep response replacement JSON compatible with the captured top-level shape.

## Scope and limitations

Page mode targets page-originated XHR and Fetch calls; static resources and service-worker-owned requests are outside its scope. Full mode intercepts tab traffic through CDP and can modify what the page receives, but requires Chrome's `debugger` permission and a per-tab attachment. Page-mode breakpoints use JavaScript's debugger pause; interactive continue controls are available in Full mode.
