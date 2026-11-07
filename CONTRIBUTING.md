# Contributing

## Requirements

- Node.js 20+ (CI uses 22)
- A Chromium-based browser, version 102 or newer
- Docker and OpenSSL for the end-to-end test, which runs a throwaway Keycloak

## Local setup

```bash
git clone https://github.com/vitlixe/keycloak-logout.git
cd keycloak-logout
npm ci
npx playwright install chromium
```

`npm ci` installs only Playwright for the end-to-end test; the extension and the
unit tests need no packages.

Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**,
and select the `extension` folder. After editing the code, click **Reload** on
the extension card. The background worker's console opens from the
**service worker** link on the card; the popup's from **Inspect** in its context
menu. A copy loaded from the repository shows version `0.0.0`: the real version
is written into the manifest only by the build.

## Development workflow

Run the same checks as CI:

```bash
node --test tests/*.test.js && for f in extension/*/*.js; do node --check "$f" || exit 1; done
```

The unit tests cover:

- `config.test.js`: settings validation and the logout URL;
- `page.test.js`: page recognition on stand-in DOMs shaped like Keycloak's
  pages (confirmation, logged out, error, foreign and look-alike forms);
- `background.test.js`: the logout flow against a fake `chrome.*` API, including
  timeouts, repeated confirmations, a second click, and a service worker restart
  in the middle of a logout.
- `access.test.js` and `popup.test.js`: the Save click's permission request,
  denied access, storage errors and the popup settings.

CI also builds `keycloak-logout.zip`, loads it into Chromium, and runs
`e2e/logout.test.mjs` against a real Keycloak, both at the root path and under
the `/auth` prefix. The test sets the extension up through its popup settings,
logs a user in, checks that a logout with a wrong realm fails visibly, and that
a normal logout ends the session in Keycloak. It also checks a fresh install,
host changes, revoked access and cleanup of legacy all-site grants. Headless
Chrome cannot display the native approval dialog, so the test approves only its
local test hostname through Chrome's site-access settings before clicking Save.
The extension's real permission APIs remain in use. Check the native Allow and
Deny prompts manually before a release, from the toolbar popup: enter
a new host, click Save, answer the prompt, then reopen the popup and check
which host it shows. To run it locally:

```bash
scripts/build.sh
unzip -qo dist/keycloak-logout.zip -d dist
e2e/start-keycloak.sh            # or: e2e/start-keycloak.sh /auth
EXT_DIR=dist/keycloak-logout node --test e2e/*.test.mjs
docker rm -f kc-logout-e2e
```

For the `/auth` run, also pass `KC_HOST=localhost:8443/auth`. The browsers the
extension targets (Chrome, Edge, Yandex Browser, Chromium-GOST) are not
covered by CI; check the popup there by hand before a release.

## Making changes

1. Create a branch from `main`.
2. Add or update tests where applicable.
3. Run the checks above; they must pass.
4. Keep the settings rules, logout URL and permission origin in
   `extension/common/config.js`. The popup uses `common/access.js`;
   its permission request must run directly in the Save click handler, before
   any asynchronous work. The page only hands the settings over in
   `storage.session`; `background.js` writes them once access is granted
   (on `permissions.onAdded` or the page's message), because the browser may
   close the popup while its prompt is open. Denying access must not change
   saved settings.
5. Keep page recognition in `extension/content/page.js` in line with Keycloak's
   base login theme (`logout-confirm.ftl`, `info.ftl`, `error.ftl`) and extend
   `tests/page.test.js` with every new case. The content script only reports the
   page; whether to confirm, succeed, or fail is decided in `background.js`.
6. Keep site access optional: the manifest must not declare required host
   permissions. Request only the configured hostname, without wildcard
   subdomains. Browsers grant all paths and ports on that HTTPS host, so keep
   the logout URL check in `background.js` as well. The worker prunes old grants
   on startup, server changes and failed settings writes; synced settings must
   never automatically grant access on another device.
7. Open a PR with a clear description of what and why.

## Releases

To publish a release, update `VERSION`, commit, and push a matching tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The tag must match the version, otherwise the release fails. After the checks
and install tests pass, CI publishes a GitHub release with
`keycloak-logout.zip` and `checksums.sha256`.
