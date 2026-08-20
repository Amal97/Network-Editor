# Chrome Web Store Submission

Use the release ZIP from `../releases/network-modifier-v1.0.0.zip`. The manifest is at the ZIP root and the package requires no external service or account.

## Product details

**Name:** Network Modifier

**Summary:** Monitor and modify frontend XHR and Fetch requests without a proxy or certificate.

**Category:** Developer Tools

**Language:** English

**Detailed description:**

Network Modifier is a frontend API debugging tool that captures and modifies Fetch and XMLHttpRequest traffic in browser tabs you explicitly select.

Inspect request and response URLs, methods, headers, bodies, status codes, timing, and rule matches in a standalone dashboard or DevTools panel. Create reusable rules to replace bodies, edit nested JSON fields, change headers or status codes, add latency, simulate failures, pause traffic, and return mock responses. Organize rules into folders and profiles, compare captured responses, simulate network conditions, and import or export rules and HAR files.

Page mode modifies Fetch and XHR at the page JavaScript layer. Full mode is optional and uses Chrome's debugger API to modify browser network responses for the selected tab. Full mode displays Chrome's standard debugging banner while attached.

All captured traffic and settings remain on the user's device. Network Modifier has no analytics, advertising, tracking, remote code, or developer-operated backend.

**Homepage URL:** https://github.com/Amal97/Network-Editor

**Support URL:** https://github.com/Amal97/Network-Editor/issues

**Privacy policy URL:** https://github.com/Amal97/Network-Editor/blob/main/extension/PRIVACY.md

**Mature content:** No

## Graphic assets

- Store icon: `store-assets/store-icon-128.png`
- Screenshot: `store-assets/dashboard-1280x800.png`
- Small promo tile: `store-assets/small-promo-440x280.png`
- Marquee promo tile: `store-assets/marquee-1400x560.png` (optional)
- Promotional video: none

## Privacy practices

**Single purpose:** Inspect and modify Fetch and XMLHttpRequest traffic in browser tabs explicitly selected by the user for frontend debugging.

**storage:** Stores user-created rules, profiles, and preferences locally on the user's device.

**tabs:** Lists eligible browser tabs so the user can select the one to inspect, and opens or focuses the Network Modifier dashboard.

**debugger:** Optional Full mode attaches Chrome DevTools Protocol only to a tab explicitly selected by the user, allowing network response inspection and modification.

**downloads:** Saves rules and captured traffic as JSON or HAR only after the user requests an export.

**Host permissions (`http://*/*`, `https://*/*`):** Allows the extension to observe and modify Fetch and XHR traffic for the selected tab regardless of the site being debugged. Traffic is processed locally and only while interception is enabled.

**Remote code:** No, the extension does not use remote code. All executable code is included in the submitted package.

**Data disclosures:** Select **Web history** and **Website content** because inspected request URLs, headers, and bodies can contain these data classes even though processing is local and temporary. Do not select personally identifiable information, health information, financial and payment information, authentication information, personal communications, location, or user activity unless product behavior changes to intentionally collect those classes. Certify that data is not sold, transferred for unrelated purposes, used for creditworthiness or lending, or used outside the extension's single purpose.

## Distribution

- Visibility: Public
- Regions: All regions
- Pricing: Free

For a cautious first launch, use deferred publishing. After approval, verify the staged listing and publish within the Chrome Web Store's 30-day window.

## Reviewer instructions

No login, paid account, or credentials are required.

1. Install and pin Network Modifier.
2. Open any HTTP or HTTPS page that makes Fetch or XMLHttpRequest calls.
3. Open the extension popup and click **Open Network Modifier**.
4. Select the test page in the target-tab menu and reload it.
5. Confirm requests appear in Traffic and can be inspected.
6. Create a rule matching one request, set a response header or body, save it, and reload the target page.
7. To test optional Full mode, select **Full - Chrome network**, accept Chrome's standard debugging banner, and repeat the request.
8. Use the export controls to save rules or traffic as HAR.

Page mode covers page-originated Fetch and XHR. Full mode covers Chrome network responses and requires the declared `debugger` permission.