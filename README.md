# Keycloak Logout

Browser extension for one-click **Keycloak (SSO)** logout. It ends the session in
a background tab and confirms the logout on the Keycloak page automatically — no
manual clicks. Works with any Keycloak server: the host and realm are set in the
options.

## Project Structure

```text
.
├── README.md
└── extension/
    ├── manifest.json
    ├── icons/        icons 16/32/48/128
    ├── popup/        window with the "Log out" button
    ├── options/      settings page (host, realm, notification)
    ├── background/   background logout tab + notification
    └── content/      auto-confirm logout on Keycloak
```

## Installation

1. Copy the whole `extension` folder to a permanent location on disk (together
   with `manifest.json`, scripts, and icons).
2. Open the extensions page:
   - Chrome — `chrome://extensions`
   - Edge — `edge://extensions`
   - Yandex Browser — `browser://extensions`
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `extension` folder.

The icon appears in the toolbar; clicking it opens a window that shows the
configured host and a **Log out** button.

## Configuration

Before first use, set your Keycloak server. Open the settings via the gear icon
in the popup corner (or right-click the icon > "Options"). Host and realm are
required — the form won't save while either is empty, and clicking **Log out**
without them opens the settings instead.

- **Host** — the Keycloak server domain, without `https://` or slashes (e.g.
  `auth.example.com`).
- **Realm** — the realm name (e.g. `master`).
- **Notification after logout** — on/off.

These fields build the logout URL:

```text
https://<host>/realms/<realm>/protocol/openid-connect/logout
```

## How It Works

1. Clicking **Log out** opens the Keycloak logout URL in a background tab.
2. A content script on that tab clicks the logout confirmation button.
3. Once there is nothing left to confirm, the tab closes and an optional
   notification is shown.

## Supported Browsers

Works in Chromium-based browsers with Manifest V3 support:

- Chrome
- Edge
- Yandex Browser
- Chromium-GOST
