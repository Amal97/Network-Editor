# Release Plan

Network Modifier ships two artifacts with one shared version:

- `network-modifier-<version>.tgz`: the proxy, CLI, and web UI npm package.
- `network-modifier-v<version>.zip`: the Manifest V3 Chrome extension.

## Release criteria

- Node.js 20.19 or newer and clean `npm ci` installs in both package roots.
- Root smoke tests, extension tests, extension typecheck, and extension build pass.
- `package.json`, `extension/package.json`, and `extension/manifest.json` have the same version.
- All product icons are generated from `assets/network-modifier.svg` with `npm --prefix extension run icons`.
- `CHANGELOG.md`, `RELEASE_NOTES.md`, privacy documentation, and user-facing README content reflect the release.

## Release procedure

1. Choose a SemVer version and update both package files, both lockfiles, and the extension manifest.
2. Move the relevant entries in `CHANGELOG.md` from Unreleased into a dated version section.
3. Update `RELEASE_NOTES.md` with concise user-facing notes and known limitations.
4. Run `npm ci` and `npm --prefix extension ci`.
5. Run `npm run release:check`.
6. Run `npm run release:package`. Inspect the `.tgz`, `.zip`, and `SHA256SUMS` in `releases/`.
7. Load `extension/dist/` unpacked in Chrome and smoke test Page mode, Full mode, rule import/export, popup launch, and the displayed icon.
8. Install the generated `.tgz` locally and smoke test startup, HTTPS capture, a response rule, and shutdown proxy cleanup on macOS and Windows.
9. Commit the release metadata, create the signed tag `v<version>`, and push it. GitHub Actions publishes the GitHub release artifacts.
10. Submit the ZIP to the Chrome Web Store using `extension/STORE_LISTING.md` and its generated assets.
11. Publish the npm package with `npm publish ./releases/network-modifier-<version>.tgz --access public` after signing in with 2FA, or configure npm Trusted Publishing for the GitHub workflow.

## First-release account setup

- GitHub CLI: run `gh auth login`, choose GitHub.com and HTTPS, then authenticate in the browser.
- npm: create an npm account with 2FA, run `npm login`, and confirm with `npm whoami`. The unscoped `network-modifier` name was available when checked on 2026-08-20 but is not reserved until publication.
- Chrome Web Store: register a dedicated publisher Google account in the Developer Dashboard, accept the agreement, and pay Google's displayed one-time registration fee. The account email cannot later be changed.
- Host the privacy policy at the public repository URL before submitting the extension.

## Rollback

- GitHub: mark the release as a pre-release or delete its artifacts, then publish a patch release.
- npm: deprecate the affected version; never reuse a published version number.
- Chrome Web Store: roll back to the previous package in the dashboard or submit a patch release.