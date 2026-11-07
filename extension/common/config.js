// Settings shared by the popup and the background worker:
// defaults, validation and the logout URL. No DOM or chrome.* use, so it can be
// loaded with <script>, importScripts() or require() in tests.
(function (root) {
  const DEFAULTS = { host: "", realm: "", notify: true };

  // chrome.storage.session key for settings the popup hands to the background
  // while the browser asks for site access (see common/access.js).
  const PENDING_KEY = "pendingSettings";

  // Path of the Keycloak logout endpoint below the server address.
  const LOGOUT_PATH = "/protocol/openid-connect/logout";

  // Normalizes the server address: optional https:// or http:// prefix, host,
  // optional port and optional path prefix (e.g. "/auth" on Keycloak < 17).
  // Returns { value } or { error }.
  function parseHost(input) {
    const raw = String(input || "").trim().replace(/^https?:\/\//i, "");
    if (!raw) return { error: "Required" };
    // Any other scheme (ftp://, file://, …) would end up as part of the host.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      return { error: "Only https:// addresses are supported" };
    }
    let url;
    try {
      url = new URL("https://" + raw);
    } catch (e) {
      return { error: "Not a valid server address" };
    }
    if (!url.hostname || url.username || url.password || url.search || url.hash) {
      return { error: "Enter only the server address" };
    }
    const path = url.pathname.replace(/\/+$/, "");
    if (path.includes("//")) return { error: "Not a valid server address" };
    if (/\/realms(\/|$)/.test(path)) {
      return { error: "Enter the server address without /realms/..." };
    }
    return { value: url.host + path };
  }

  // Realm names are put into the URL path encoded; only values that cannot be
  // encoded into a single path segment are rejected.
  function parseRealm(input) {
    const realm = String(input || "").trim();
    if (!realm) return { error: "Required" };
    if (/[/\\]/.test(realm) || realm === "." || realm === "..") {
      return { error: "Not a valid realm name" };
    }
    return { value: realm };
  }

  // Validates raw settings. Returns { cfg } when valid, otherwise { errors }
  // with a message per invalid field.
  function validate(input) {
    const host = parseHost(input.host);
    const realm = parseRealm(input.realm);
    if (host.error || realm.error) {
      const errors = {};
      if (host.error) errors.host = host.error;
      if (realm.error) errors.realm = realm.error;
      return { errors };
    }
    return {
      cfg: { host: host.value, realm: realm.value, notify: input.notify !== false },
    };
  }

  function buildLogoutUrl(cfg) {
    return (
      "https://" + cfg.host + "/realms/" + encodeURIComponent(cfg.realm) + LOGOUT_PATH
    );
  }

  // Host permissions cover all paths and ports on a host. Do not include the
  // configured path prefix or request subdomains with a wildcard.
  function permissionOrigin(cfg) {
    return "https://" + new URL(buildLogoutUrl(cfg)).hostname + "/*";
  }

  // True when pageUrl is the logout endpoint itself or a page below it
  // (Keycloak answers the confirmation on .../logout/logout-confirm).
  function isLogoutPage(pageUrl, logoutUrl) {
    let page, base;
    try {
      page = new URL(pageUrl);
      base = new URL(logoutUrl);
    } catch (e) {
      return false;
    }
    if (page.origin !== base.origin) return false;
    return page.pathname === base.pathname || page.pathname.startsWith(base.pathname + "/");
  }

  const api = { DEFAULTS, PENDING_KEY, parseHost, parseRealm, validate, buildLogoutUrl, permissionOrigin, isLogoutPage };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KcConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
