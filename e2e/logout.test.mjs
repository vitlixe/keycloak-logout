// End-to-end test of the packed extension against a real Keycloak started by
// e2e/start-keycloak.sh. Loads the unpacked release zip into Chromium, sets
// the extension up through its popup settings, logs in a test user and logs
// out through the popup, checking the session in Keycloak's admin API.
//
// EXT_DIR  folder with the unpacked extension (the one holding manifest.json)
// KC_HOST  server address as typed into the settings, default localhost:8443
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, request } from "playwright";

const EXT_DIR = path.resolve(process.env.EXT_DIR || "");
const KC_HOST = process.env.KC_HOST || "localhost:8443";
const BASE = `https://${KC_HOST}`;
const REALM = "e2e";
const USER = "alice";
const PASSWORD = "alice-e2e-password";

let context;
let api;
let extId;
let profile;

async function waitFor(check, { timeout = 20000, what = "condition" } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function adminHeaders() {
  const resp = await api.post(`${BASE}/realms/master/protocol/openid-connect/token`, {
    form: { grant_type: "password", client_id: "admin-cli", username: "admin", password: "admin" },
  });
  assert.ok(resp.ok(), `admin token: HTTP ${resp.status()}`);
  return { Authorization: `Bearer ${(await resp.json()).access_token}` };
}

async function userUrl(headers) {
  const users = await (
    await api.get(`${BASE}/admin/realms/${REALM}/users?username=${USER}&exact=true`, { headers })
  ).json();
  return `${BASE}/admin/realms/${REALM}/users/${users[0].id}`;
}

async function sessionCount() {
  const headers = await adminHeaders();
  const sessions = await (await api.get(`${await userUrl(headers)}/sessions`, { headers })).json();
  return sessions.length;
}

// Ends the user's sessions left over from earlier runs against the same server.
async function endAllSessions() {
  const headers = await adminHeaders();
  const resp = await api.post(`${await userUrl(headers)}/logout`, { headers });
  assert.ok(resp.ok(), `admin logout: HTTP ${resp.status()}`);
  await waitFor(async () => (await sessionCount()) === 0, { what: "a clean start" });
}

async function login() {
  const page = await context.newPage();
  const redirect = encodeURIComponent(`${BASE}/realms/${REALM}/`);
  await page.goto(
    `${BASE}/realms/${REALM}/protocol/openid-connect/auth` +
      `?client_id=e2e-app&response_type=code&scope=openid&redirect_uri=${redirect}`
  );
  await page.fill("#username", USER);
  await page.fill("#password", PASSWORD);
  await page.click("#kc-login");
  await waitFor(async () => (await sessionCount()) === 1, { what: "Keycloak session" });
  await page.close();
}

// Headless Chrome cannot display the native approval dialog. Grant only the
// test host through Chrome's real site-access settings, then exercise the
// extension's permissions.request and save flow. No production APIs are mocked.
async function approveHost(host) {
  const hostname = new URL(`https://${host}`).hostname;
  assert.ok(["localhost", "127.0.0.1"].includes(hostname));
  const settings = await context.newPage();
  await settings.goto("chrome://extensions");
  await settings.evaluate(async ({ id, origin }) => {
    await chrome.developerPrivate.addHostPermission(id, origin);
  }, { id: extId, origin: `https://${hostname}/*` });
  await settings.close();
}

async function origins() {
  return (await worker()).evaluate(async () => (await chrome.permissions.getAll()).origins || []);
}

// Saves through the popup settings, after the browser-side approval.
async function configure(host, realm) {
  await approveHost(host);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/popup/popup.html`);
  await page.click("#settings-open");
  await page.fill("#host", host);
  await page.fill("#realm", realm);
  await page.click("#settings-save");
  await page.waitForFunction(() => document.getElementById("settings-save").textContent === "Saved");
  await page.close();
}

// Clicks Log out in the popup page and returns the tab the extension opened.
async function clickLogout() {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  const opened = context.waitForEvent("page", { timeout: 10000 });
  await popup.click("#logout");
  const tab = await opened;
  await tab.waitForURL(/\/protocol\/openid-connect\/logout/, { timeout: 10000 });
  return tab;
}

async function worker() {
  return context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
}

// The running logout as stored by the background worker, or null.
async function runningLogout() {
  return (await worker()).evaluate(
    async () => (await chrome.storage.session.get("logoutOp")).logoutOp || null
  );
}

// True once the logout tab was brought to the front. The extension opens it in
// the background and activates it only to show a failed logout.
async function logoutTabActivated() {
  return (await worker()).evaluate(async () => {
    const tabs = await chrome.tabs.query({
      active: true,
      url: "https://*/*realms/*/protocol/openid-connect/logout*",
    });
    return tabs.length > 0;
  });
}

test.before(async () => {
  assert.ok(
    fs.existsSync(path.join(EXT_DIR, "manifest.json")),
    "EXT_DIR must point to the unpacked extension"
  );
  api = await request.newContext({ ignoreHTTPSErrors: true });
  await endAllSessions();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "kc-logout-e2e-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--ignore-certificate-errors",
    ],
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  extId = new URL(worker.url()).host;
});

test.after(async () => {
  await context?.close();
  await api?.dispose();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test("fresh install grants no hosts; existing settings need explicit access", async () => {
  assert.deepEqual(await origins(), []);
  await (await worker()).evaluate(async (host) => {
    await chrome.storage.sync.set({ host, realm: "e2e", notify: true });
  }, KC_HOST);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  const count = context.pages().length;
  await popup.click("#logout");
  await popup.waitForSelector("body.settings-open");
  assert.match(await popup.locator("#settings-status").textContent(), /allow access/i);
  assert.equal(context.pages().length, count, "no logout tab without permission");
  assert.deepEqual(await origins(), []);
  await popup.close();
});

test("saving popup settings retains only the selected host", async () => {
  await configure(KC_HOST, REALM);
  assert.deepEqual(await origins(), ["https://localhost/*"]);
  await configure(KC_HOST.replace("localhost", "127.0.0.1"), REALM);
  assert.deepEqual(await origins(), ["https://127.0.0.1/*"]);
  await configure(KC_HOST, REALM);
  assert.deepEqual(await origins(), ["https://localhost/*"]);
});

test("revoked access returns to settings without opening a logout tab", async () => {
  await (await worker()).evaluate(async () => {
    await chrome.permissions.remove({ origins: ["https://localhost/*"] });
  });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  const count = context.pages().length;
  await popup.click("#logout");
  await popup.waitForSelector("body.settings-open");
  assert.match(await popup.locator("#settings-status").textContent(), /allow access/i);
  assert.equal(context.pages().length, count);
  await popup.close();
  await configure(KC_HOST, REALM);
});

test("wrong realm: the failure is visible and the session stays", async () => {
  await login();
  await configure(KC_HOST, "no-such-realm");

  const tab = await clickLogout();
  await waitFor(logoutTabActivated, { what: "the failed logout tab to come forward" });

  assert.equal(tab.isClosed(), false, "the failed logout tab must stay open");
  assert.equal(await runningLogout(), null);
  assert.equal(await sessionCount(), 1);
  await tab.close();
});

test("logout confirms on Keycloak, ends the session and closes the tab", async () => {
  await configure(KC_HOST, REALM);

  const tab = await clickLogout();
  await tab.waitForEvent("close", { timeout: 20000 });

  assert.equal(await sessionCount(), 0);
  assert.equal(await runningLogout(), null);
});

test("reconciliation removes a legacy all-site grant", async () => {
  const settings = await context.newPage();
  await settings.goto("chrome://extensions");
  // Reproduce the grant retained by older versions, only in this disposable
  // browser profile. Reconcile must remove it before the next logout.
  await settings.evaluate(async (id) => {
    await chrome.developerPrivate.addHostPermission(id, "https://*/*");
  }, extId);
  await settings.close();
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/popup/popup.html`);
  // Grant the remembered legacy permission with a real click so it becomes
  // active, rather than merely recorded in Chrome's permission history.
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "grant-legacy-access";
    button.textContent = "Grant legacy access for this test";
    button.addEventListener("click", () => {
      chrome.permissions.request({ origins: ["https://*/*"] }).then((granted) => {
        window.legacyAccessGranted = granted;
      });
    });
    document.body.append(button);
  });
  await page.click("#grant-legacy-access");
  await page.waitForFunction(() => window.legacyAccessGranted === true);
  assert.ok((await origins()).includes("https://*/*"));
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "settings-saved" }));
  assert.ok((await origins()).every((origin) => origin === "https://localhost/*"));
  await page.close();
  await configure(KC_HOST, REALM);
  assert.deepEqual(await origins(), ["https://localhost/*"]);
});
