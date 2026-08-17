# Network Modifier Extension

A standalone Manifest V3 Chrome extension for monitoring and modifying frontend XHR and Fetch traffic. It does not require the Network Modifier proxy or a trusted certificate.

## Current capabilities

- Capture Fetch and XMLHttpRequest traffic from inspected tabs
- Inspect request/response bodies, status, headers, and timing
- Match rules by HTTP method and URL text or regular expression
- Replace request and response bodies (`{{body}}` inserts the previous body)
- Override response status for frontend-visible responses
- Add delay, simulate Fetch failures, and return Fetch mock responses
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

Use `npm run watch` while developing, then click Reload on the extension card after changes.

## Scope and limitations

This extension intentionally targets page-originated XHR and Fetch calls. Static documents, scripts, styles, images, downloads, browser-internal requests, and service-worker-owned requests are outside body modification scope. Fetch supports the complete first-version rule set; XHR currently supports request-body and frontend-visible response/status rewriting, while native XHR event timing and network failures remain browser-controlled.
