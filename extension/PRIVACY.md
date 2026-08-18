# Privacy Policy

Network Modifier processes browser request and response data locally to let users inspect and modify traffic in tabs they explicitly select.

- Rules, profiles, and preferences are stored in `chrome.storage.local` on the user's device.
- Captured traffic is retained only in extension memory and is discarded when Chrome or the extension restarts.
- Exported rules and HAR files are created only when the user requests them.
- Network Modifier does not transmit, sell, or share browsing data, rules, or captured traffic with the developer or third parties.

The extension requests access to HTTP and HTTPS pages to intercept Fetch and XMLHttpRequest traffic. The `debugger` permission is used only when Full mode is enabled for a selected tab. The `downloads` permission is used for user-requested exports.
