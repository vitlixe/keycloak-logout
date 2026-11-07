// Logout state machine of the background worker, run against a fake chrome.*
// API. Each worker instance is a fresh VM context; sharing `session` between
// two instances models the service worker being stopped and restarted.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..", "extension");
const BACKGROUND = fs.readFileSync(path.join(EXT, "background/background.js"), "utf8");
const LOGOUT = "https://auth.example.com/realms/master/protocol/openid-connect/logout";

function createWorld({
  sync = { host: "auth.example.com", realm: "master", notify: true },
  origins = ["https://auth.example.com/*"],
} = {}) {
  return {
    sync: { ...sync },
    session: {},
    tabs: new Map(),
    nextTabId: 1,
    removed: [],
    activated: [],
    injected: [],
    notifications: [],
    injectError: null,
    syncError: null,
    origins: new Set(origins),
    now: 1_000_000,
  };
}

function startWorker(world) {
  const listeners = { updated: [], removed: [], message: [], storage: [], added: [] };
  const timers = [];
  const chrome = {
    storage: {
      session: {
        get: async (key) => (key in world.session ? { [key]: world.session[key] } : {}),
        set: async (obj) => Object.assign(world.session, structuredClone(obj)),
        remove: async (key) => void delete world.session[key],
      },
      sync: {
        get: async (defaults) => ({ ...defaults, ...world.sync }),
        set: async (obj) => {
          if (world.syncError) throw new Error(world.syncError);
          Object.assign(world.sync, structuredClone(obj));
        },
      },
      onChanged: { addListener: (fn) => listeners.storage.push(fn) },
    },
    permissions: {
      getAll: async () => ({ origins: [...world.origins] }),
      contains: async ({ origins }) => origins.every((origin) =>
        world.origins.has(origin) || world.origins.has("https://*/*")
      ),
      remove: async ({ origins }) => {
        for (const origin of origins) world.origins.delete(origin);
        return true;
      },
      onAdded: { addListener: (fn) => listeners.added.push(fn) },
    },
    tabs: {
      create: async ({ url, active }) => {
        const tab = { id: world.nextTabId++, url, active, windowId: 7 };
        world.tabs.set(tab.id, tab);
        return tab;
      },
      update: async (id, props) => {
        const tab = world.tabs.get(id);
        if (!tab) throw new Error("No tab with id " + id);
        if (props.active) world.activated.push(id);
        return tab;
      },
      remove: async (id) => {
        world.tabs.delete(id);
        world.removed.push(id);
      },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
    },
    windows: { update: async () => ({}) },
    scripting: {
      executeScript: async ({ target, files }) => {
        if (world.injectError) throw new Error(world.injectError);
        world.injected.push({ tabId: target.tabId, files: [...files] });
      },
    },
    notifications: { create: (opts) => world.notifications.push(opts.message) },
    runtime: {
      getURL: (p) => "chrome-extension://test/" + p,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
  };

  const context = vm.createContext({
    chrome,
    console: { warn() {}, log() {} },
    URL,
    Date: { now: () => world.now },
    setTimeout: (fn, ms) => timers.push({ fn, at: world.now + ms }) - 1,
    clearTimeout: (id) => {
      if (timers[id]) timers[id].fn = null;
    },
  });
  context.importScripts = (rel) => {
    const file = path.join(EXT, "background", rel);
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  };
  vm.runInContext(BACKGROUND, context, { filename: "background.js" });

  // Replies are serialized, as chrome.runtime messaging does.
  function send(msg, sender = {}) {
    return new Promise((resolve) => {
      const reply = (resp) => resolve(JSON.parse(JSON.stringify(resp)));
      for (const fn of listeners.message) fn(msg, sender, reply);
    });
  }

  return {
    // From the toolbar popup (no tab) or popup.html opened in a tab.
    logout: (sender = { url: "chrome-extension://test/popup/popup.html" }) =>
      send({ type: "logout" }, sender),
    page: (tabId, kind) =>
      send({ type: "logout-page", kind }, { tab: { id: tabId }, url: LOGOUT }),
    send,
    settingsSaved: (id) => send({ type: "settings-saved", id }, {
      url: "chrome-extension://test/popup/popup.html",
    }),
    // The user allowed access in the browser's prompt.
    async granted(origin) {
      world.origins.add(origin);
      for (const fn of listeners.added) fn({ origins: [origin] });
      await settle();
    },
    async changed(changes, area = "sync") {
      for (const fn of listeners.storage) fn(changes, area);
      await settle();
    },
    async loaded(tabId, url) {
      for (const fn of listeners.updated) fn(tabId, { status: "complete" }, { id: tabId, url });
      await settle();
    },
    async closedByUser(tabId) {
      world.tabs.delete(tabId);
      for (const fn of listeners.removed) fn(tabId);
      await settle();
    },
    // Advance the clock and run due timers.
    async advance(ms) {
      world.now += ms;
      for (const t of timers) {
        if (t.fn && t.at <= world.now) {
          const fn = t.fn;
          t.fn = null;
          fn();
        }
      }
      await settle();
    },
  };
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

test("full logout: confirm, then logged-out page closes the tab and notifies", async () => {
  const world = createWorld();
  const bg = startWorker(world);

  assert.deepEqual(await bg.logout(), { status: "started" });
  const tab = world.tabs.get(1);
  assert.equal(tab.url, LOGOUT);
  assert.equal(tab.active, false);

  await bg.loaded(1, LOGOUT);
  assert.deepEqual(world.injected, [
    { tabId: 1, files: ["content/page.js", "content/auto-confirm.js"] },
  ]);
  assert.deepEqual(await bg.page(1, "confirm"), { click: true });

  await bg.loaded(1, LOGOUT + "/logout-confirm");
  assert.deepEqual(await bg.page(1, "logged-out"), { click: false });
  await settle();

  assert.deepEqual(world.removed, [1]);
  assert.deepEqual(world.notifications, ["You have logged out of the SSO session"]);
  assert.deepEqual(world.session, {});
});

test("success notification follows the setting", async () => {
  const world = createWorld({ sync: { host: "auth.example.com", realm: "master", notify: false } });
  const bg = startWorker(world);
  await bg.logout();
  await bg.page(1, "logged-out");
  await settle();
  assert.deepEqual(world.removed, [1]);
  assert.deepEqual(world.notifications, []);
});

for (const [kind, reason] of [
  ["error", "Keycloak showed an error"],
  ["unknown", "the page was not recognized as Keycloak logout"],
]) {
  test(`${kind} page: tab stays open and comes forward, failure is always reported`, async () => {
    const world = createWorld({ sync: { host: "auth.example.com", realm: "master", notify: false } });
    const bg = startWorker(world);
    await bg.logout();
    await bg.loaded(1, LOGOUT);
    assert.deepEqual(await bg.page(1, kind), { click: false });
    await settle();

    assert.deepEqual(world.removed, []);
    assert.deepEqual(world.activated, [1]);
    assert.equal(world.notifications.length, 1);
    assert.match(world.notifications[0], new RegExp("not confirmed: " + reason));
    assert.deepEqual(world.session, {});
  });
}

test("unreachable server: injection fails, logout reported as failed", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await bg.logout();
  world.injectError = "Frame with ID 0 is showing error page";
  await bg.loaded(1, LOGOUT);
  assert.deepEqual(world.activated, [1]);
  assert.match(world.notifications[0], /could not be opened/);
});

test("redirect to an unexpected page: nothing injected, failure reported", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await bg.logout();
  await bg.loaded(1, "https://other.example.com/login");
  assert.deepEqual(world.injected, []);
  assert.match(world.notifications[0], /unexpected page/);
});

test("hidden or blank tab URL is not a verdict; the timeout decides", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await bg.logout();
  await bg.loaded(1, "");
  await bg.loaded(1, "about:blank");
  assert.deepEqual(world.injected, []);
  assert.deepEqual(world.notifications, []);
  await bg.advance(15_000);
  assert.match(world.notifications[0], /in time/);
});

test("second click while a logout runs does not open another tab", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  const [a, b] = await Promise.all([bg.logout(), bg.logout()]);
  assert.deepEqual([a.status, b.status].sort(), ["busy", "started"]);
  assert.equal(world.tabs.size, 1);
});

test("Keycloak asking to confirm again and again stops after the limit", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await bg.logout();
  assert.deepEqual(await bg.page(1, "confirm"), { click: true });
  assert.deepEqual(await bg.page(1, "confirm"), { click: true });
  assert.deepEqual(await bg.page(1, "confirm"), { click: false });
  await settle();
  assert.match(world.notifications[0], /keeps asking to confirm/);
});

test("timeout: a stuck logout is reported and a new one can start", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await bg.logout();
  await bg.advance(14_000);
  assert.deepEqual(world.notifications, []);
  await bg.advance(1_000);
  assert.match(world.notifications[0], /did not finish the logout in time/);
  assert.deepEqual(world.activated, [1]);
  assert.deepEqual(await bg.logout(), { status: "started" });
});

test("worker restart mid-logout keeps the operation", async () => {
  const world = createWorld();
  const first = startWorker(world);
  await first.logout();

  const second = startWorker(world); // same storage.session, fresh memory
  await settle();
  assert.deepEqual(await second.page(1, "logged-out"), { click: false });
  await settle();
  assert.deepEqual(world.removed, [1]);
  assert.deepEqual(world.notifications, ["You have logged out of the SSO session"]);
});

test("worker restart after the deadline reports the timeout", async () => {
  const world = createWorld();
  await startWorker(world).logout();
  world.now += 60_000;
  const restarted = startWorker(world);
  await settle();
  await restarted.advance(0); // the overdue timer is armed with a zero delay
  assert.match(world.notifications[0], /in time/);
  assert.deepEqual(world.session, {});
});

test("user closing the logout tab ends the operation silently", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await bg.logout();
  await bg.closedByUser(1);
  assert.deepEqual(world.session, {});
  assert.deepEqual(world.notifications, []);
  assert.deepEqual(await bg.logout(), { status: "started" });
});

test("not configured: no tab is opened", async () => {
  const world = createWorld({ sync: { host: "", realm: "" } });
  const bg = startWorker(world);
  assert.deepEqual(await bg.logout(), { status: "not-configured" });
  assert.equal(world.tabs.size, 0);
});

test("popup.html opened in a regular tab can start a logout", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  const sender = { tab: { id: 42 }, url: "chrome-extension://test/popup/popup.html" };
  assert.deepEqual(await bg.logout(sender), { status: "started" });
});

test("web pages cannot start a logout or report as the logout tab", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  const page = { tab: { id: 5 }, url: "https://evil.example.com/" };
  const ignored = Promise.race([
    bg.send({ type: "logout" }, page),
    new Promise((r) => setTimeout(() => r("no reply"), 50)),
  ]);
  assert.equal(await ignored, "no reply");
  assert.equal(world.tabs.size, 0);

  // An extension page pretending to be the logout tab is ignored too.
  await bg.logout();
  const fake = Promise.race([
    bg.send(
      { type: "logout-page", kind: "logged-out" },
      { tab: { id: 1 }, url: "chrome-extension://test/popup/popup.html" }
    ),
    new Promise((r) => setTimeout(() => r("no reply"), 50)),
  ]);
  assert.equal(await fake, "no reply");
  assert.deepEqual(world.removed, []);
});

test("messages from tabs other than the logout tab are ignored", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await bg.logout();
  assert.deepEqual(await bg.page(99, "logged-out"), { click: false });
  assert.deepEqual(await bg.page(99, "confirm"), { click: false });
  assert.deepEqual(world.removed, []);
  assert.ok(world.session.logoutOp);
});

test("no host permission: do not open a logout tab", async () => {
  const world = createWorld({ origins: [] });
  const bg = startWorker(world);
  assert.deepEqual(await bg.logout(), { status: "permission-required" });
  assert.equal(world.tabs.size, 0);
  assert.deepEqual(world.notifications, []);
});

test("upgrade removes the legacy all-HTTPS grant but keeps settings", async () => {
  const world = createWorld({ origins: ["https://*/*"] });
  const bg = startWorker(world);
  await settle();
  assert.deepEqual([...world.origins], []);
  assert.equal(world.sync.host, "auth.example.com");
  assert.deepEqual(await bg.logout(), { status: "permission-required" });
});

test("saving a new server removes grants for previous servers", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await settle();
  world.origins.add("https://new.example.com/*");
  world.sync.host = "new.example.com/auth";
  assert.deepEqual(await bg.settingsSaved(), { status: "saved" });
  assert.deepEqual([...world.origins], ["https://new.example.com/*"]);
});

test("failed settings write: old host kept, new grant removed, error reported", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await settle();
  handOver(world, { host: "unused.example.com", realm: "master", notify: true });
  world.origins.add("https://unused.example.com/*");
  world.syncError = "QUOTA_BYTES quota exceeded";
  assert.deepEqual(await bg.settingsSaved("attempt-1"), { status: "error" });
  assert.equal(world.sync.host, "auth.example.com");
  assert.deepEqual([...world.origins], ["https://auth.example.com/*"]);
  assert.equal(world.session.pendingSettings, undefined);
});

// What common/access.js stores before asking the browser for access.
function handOver(world, cfg, id = "attempt-1") {
  world.session.pendingSettings = { id, cfg, at: world.now };
}

const NEW_CFG = { host: "new.example.com/auth", realm: "team", notify: false };

test("popup closed during the prompt: granting access still saves the settings", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await settle();
  handOver(world, NEW_CFG);
  // The page is gone; only the browser's grant event reaches the worker.
  await bg.granted("https://new.example.com/*");
  assert.deepEqual(world.sync, NEW_CFG);
  assert.deepEqual([...world.origins], ["https://new.example.com/*"]);
  assert.equal(world.session.pendingSettings, undefined);
});

test("access already granted: the page's message saves the settings", async () => {
  const world = createWorld({ origins: ["https://auth.example.com/*"] });
  const bg = startWorker(world);
  await settle();
  const sameHost = { host: "auth.example.com", realm: "other", notify: true };
  handOver(world, sameHost);
  assert.deepEqual(await bg.settingsSaved("attempt-1"), { status: "saved" });
  assert.deepEqual(world.sync, sameHost);
  assert.equal(world.session.pendingSettings, undefined);
});

test("prompt still open: other events neither save nor drop the handed-over settings", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await settle();
  handOver(world, NEW_CFG);
  await bg.granted("https://elsewhere.example.com/*");
  await bg.changed({ notify: { newValue: false } });
  assert.equal(world.sync.host, "auth.example.com");
  assert.ok(world.session.pendingSettings, "kept until the user answers");
});

test("grants without a pending save are left alone", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await settle();
  await bg.granted("https://other.example.com/*");
  assert.deepEqual([...world.origins].sort(), [
    "https://auth.example.com/*",
    "https://other.example.com/*",
  ]);
});

test("an abandoned hand-over expires and is never saved later", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await settle();
  handOver(world, NEW_CFG);
  world.now += 6 * 60 * 1000;
  await bg.granted("https://new.example.com/*");
  assert.equal(world.sync.host, "auth.example.com");
  assert.equal(world.session.pendingSettings, undefined);
});

test("worker restart: a granted hand-over is saved on startup", async () => {
  const world = createWorld();
  handOver(world, NEW_CFG);
  world.origins.add("https://new.example.com/*");
  startWorker(world);
  await settle();
  assert.deepEqual(world.sync, NEW_CFG);
  assert.deepEqual([...world.origins], ["https://new.example.com/*"]);
});

test("synced server settings revoke old access without granting the new host", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await settle();
  world.sync.host = "synced.example.com";
  await bg.changed({ host: { newValue: world.sync.host } });
  assert.deepEqual([...world.origins], []);
  assert.deepEqual(await bg.logout(), { status: "permission-required" });
});

test("revoked permission is detected before starting a logout", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await settle();
  world.origins.clear();
  assert.deepEqual(await bg.logout(), { status: "permission-required" });
  assert.equal(world.tabs.size, 0);
});

test("changing servers ends the pending attempt before removing its access", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await bg.logout();
  world.origins.add("https://new.example.com/*");
  world.sync.host = "new.example.com";
  await bg.changed({ host: { newValue: world.sync.host } });
  assert.deepEqual(world.session, {});
  assert.deepEqual(world.activated, [1]);
  assert.match(world.notifications[0], /settings changed/);
  assert.deepEqual([...world.origins], ["https://new.example.com/*"]);
});

test("a write that failed on the grant event is reported as failed to the page", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await settle();
  handOver(world, NEW_CFG);
  world.syncError = "QUOTA_BYTES quota exceeded";
  await bg.granted("https://new.example.com/*"); // the background tries first
  assert.deepEqual(await bg.settingsSaved("attempt-1"), { status: "error" });
  assert.equal(world.sync.host, "auth.example.com");
  assert.deepEqual([...world.origins], ["https://auth.example.com/*"]);
});

test("a save finished on the grant event is reported as saved to the page", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await settle();
  handOver(world, NEW_CFG);
  await bg.granted("https://new.example.com/*");
  assert.deepEqual(await bg.settingsSaved("attempt-1"), { status: "saved" });
});

test("grant event before the hand-over lands: saved when the hand-over appears", async () => {
  const world = createWorld();
  const bg = startWorker(world);
  await settle();
  await bg.granted("https://new.example.com/*"); // nothing handed over yet
  assert.equal(world.sync.host, "auth.example.com");
  handOver(world, NEW_CFG);
  await bg.changed({ pendingSettings: { newValue: world.session.pendingSettings } }, "session");
  assert.deepEqual(world.sync, NEW_CFG);
  assert.deepEqual([...world.origins], ["https://new.example.com/*"]);
});

test("an attempt replaced by a newer save is not reported as saved", async () => {
  const world = createWorld({ origins: ["https://auth.example.com/*"] });
  const bg = startWorker(world);
  await settle();
  handOver(world, { host: "auth.example.com", realm: "newer", notify: true }, "attempt-2");
  assert.deepEqual(await bg.settingsSaved("attempt-1"), { status: "error" });
  assert.deepEqual(await bg.settingsSaved("attempt-2"), { status: "saved" });
  assert.equal(world.sync.realm, "newer");
});
