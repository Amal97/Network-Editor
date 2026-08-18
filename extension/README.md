# Network Modifier Extension

A standalone Manifest V3 Chrome extension for monitoring and modifying frontend XHR and Fetch traffic. It does not require the Network Modifier proxy or a trusted certificate.

## Current capabilities

- Capture Fetch and XMLHttpRequest traffic from inspected tabs
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

## Build and load

```sh
npm install
npm run build
```

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the generated `dist/` directory.
4. Open DevTools on a page and choose **Network Modifier**.
5. Reload the page so interception starts at `document_start`.

Use **Page mode** for lightweight Fetch/XHR modification. Use **Full mode** when the page must consume a wire-level replacement. Chrome displays an automation/debugging banner while Full mode is attached.

Response replacement rules wait for the upstream response headers and then fulfill the paused response, matching the response-mutation architecture used by Netify. Static replacement bodies skip downloading the original body; `{{body}}` templates and JSON edits retrieve it first. **Copy response** remains available for transferring a captured body elsewhere.

Use `npm run watch` while developing, then click Reload on the extension card after changes.

## Scope and limitations

Page mode targets page-originated XHR and Fetch calls; static resources and service-worker-owned requests are outside its scope. Full mode intercepts tab traffic through CDP and can modify what the page receives, but requires Chrome's `debugger` permission and a per-tab attachment. Page-mode breakpoints use JavaScript's debugger pause; interactive continue controls are available in Full mode.
