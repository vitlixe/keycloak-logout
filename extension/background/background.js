// Runs one logout at a time: opens the Keycloak logout page in a background
// tab, lets the content script confirm it, and closes the tab only once the
// "logged out" page is recognized. Anything else (error page, unknown page,
// timeout) leaves the tab open, switches to it and shows a notification.
//
// The running operation lives in chrome.storage.session, so it survives the
// service worker being stopped and restarted in the middle of a logout.

importScripts("../common/config.js");

const OP_KEY = "logoutOp";
const TIMEOUT_MS = 15000;
// The confirmation form normally appears once; a second time is allowed (e.g.
// after a language switch), more than that means Keycloak keeps rejecting it.
const MAX_CONFIRMS = 2;
const TITLE = "Keycloak Logout";

// Handlers read and write the operation asynchronously; run them one by one so
// two events never act on the same stale state.
let queue = Promise.resolve();
function serial(fn) {
  // fn gets no arguments, never the previous handler's result.
  const run = queue.then(() => fn());
  queue = run.catch((err) => console.warn("Keycloak Logout:", err));
  return run;
}

async function getOp() {
  const data = await chrome.storage.session.get(OP_KEY);
  return data[OP_KEY] || null;
}

function setOp(op) {
  return op
    ? chrome.storage.session.set({ [OP_KEY]: op })
    : chrome.storage.session.remove(OP_KEY);
}

// Timer for the running operation; restarted from storage when the worker wakes.
let timer = null;
function armTimeout(op) {
  clearTimeout(timer);
  timer = null;
  if (!op) return;
  timer = setTimeout(() => serial(checkTimeout), Math.max(0, op.deadline - Date.now()));
}

async function checkTimeout() {
  const op = await getOp();
  if (op && Date.now() >= op.deadline) {
    await fail(op, "Keycloak did not finish the logout in time");
  }
}

function notify(message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title: TITLE,
    message,
  });
}

// Close with retries: Chromium may report the tab is being dragged.
function closeTab(id, attempt = 0) {
  chrome.tabs.remove(id).catch(() => {
    if (attempt < 10) setTimeout(() => closeTab(id, attempt + 1), 250);
  });
}

async function finish() {
  await setOp(null);
  armTimeout(null);
}

async function succeed(op) {
  await finish();
  closeTab(op.tabId);
  const { notify: wanted } = await chrome.storage.sync.get({ notify: true });
  if (wanted) notify("You have logged out of the SSO session");
}

// Failures are always reported, whatever the notification setting: the popup
// is already closed and the user would otherwise believe they are logged out.
async function fail(op, reason) {
  await finish();
  try {
    const tab = await chrome.tabs.update(op.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) {
    // The tab is gone; the notification is all that is left.
  }
  notify(`Logout was not confirmed: ${reason}. Check the Keycloak tab.`);
}

// Keep only the exact configured host. This also removes the old all-HTTPS
// grant on upgrade. Permissions are local to each browser; sync settings do
// not grant access on another device.
async function prunePermissions(cfg) {
  const keep = cfg ? KcConfig.permissionOrigin(cfg) : null;
  const { origins = [] } = await chrome.permissions.getAll();
  const obsolete = origins.filter((origin) => origin !== keep);
  if (obsolete.length) await chrome.permissions.remove({ origins: obsolete });
}

// Settings the popup handed over before asking for access are saved
// only within this window; the user may take a while to answer the prompt.
// Expiry is checked whenever a hand-over is looked at. An expired one left
// behind is never saved and goes away with the browser session.
const PENDING_TTL_MS = 5 * 60 * 1000;

// Outcome of the last save attempt, { id, status: "saved" | "error" }. Both the
// grant event and the page's message may finish an attempt; whichever comes
// second reads the outcome here instead of guessing from the stored settings.
const RESULT_KEY = "settingsSaveResult";

// Writes the settings handed over by the popup once access to their
// host is granted and records the outcome of that attempt. While the prompt is
// still open (or after a denial) access is missing and nothing happens.
async function commitPendingSettings() {
  const key = KcConfig.PENDING_KEY;
  const { [key]: pending } = await chrome.storage.session.get(key);
  if (!pending) return;
  const { cfg } = KcConfig.validate(pending.cfg || {});
  if (!cfg || Date.now() - pending.at > PENDING_TTL_MS) {
    await chrome.storage.session.remove(key);
    return;
  }
  if (!(await chrome.permissions.contains({ origins: [KcConfig.permissionOrigin(cfg)] }))) {
    return;
  }
  let status = "saved";
  try {
    await chrome.storage.sync.set(cfg);
  } catch (err) {
    // E.g. sync quota exceeded: the old settings stay, and the prune in
    // reconcileSettings removes the access granted for the unsaved host.
    status = "error";
    console.warn("Keycloak Logout: could not save settings", err);
  }
  await chrome.storage.session.set({ [RESULT_KEY]: { id: pending.id, status } });
  await chrome.storage.session.remove(key);
}

// attemptId: set when the popup asks for the result of its own save.
async function reconcileSettings(attemptId) {
  await commitPendingSettings();

  const { cfg } = KcConfig.validate(await chrome.storage.sync.get(KcConfig.DEFAULTS));
  const op = await getOp();
  if (op && (!cfg || op.url !== KcConfig.buildLogoutUrl(cfg))) {
    await fail(op, "the Keycloak settings changed during logout");
  }
  await prunePermissions(cfg);

  if (attemptId) {
    const { [RESULT_KEY]: result } = await chrome.storage.session.get(RESULT_KEY);
    // No outcome for this attempt: it expired or a newer save replaced it.
    if (!result || result.id !== attemptId || result.status !== "saved") {
      return { status: "error" };
    }
  }
  if (!cfg) return { status: "not-configured" };
  const allowed = await chrome.permissions.contains({ origins: [KcConfig.permissionOrigin(cfg)] });
  return { status: allowed ? "saved" : "permission-required" };
}

async function start() {
  const running = await getOp();
  if (running && Date.now() < running.deadline) return { status: "busy" };
  if (running) await fail(running, "Keycloak did not finish the logout in time");

  const stored = await chrome.storage.sync.get(KcConfig.DEFAULTS);
  const { cfg } = KcConfig.validate(stored);
  if (!cfg) return { status: "not-configured" };

  await prunePermissions(cfg);
  if (!(await chrome.permissions.contains({ origins: [KcConfig.permissionOrigin(cfg)] }))) {
    return { status: "permission-required" };
  }

  const url = KcConfig.buildLogoutUrl(cfg);
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (err) {
    notify("Logout failed: could not open the Keycloak page.");
    return { status: "error" };
  }
  const op = { tabId: tab.id, url, deadline: Date.now() + TIMEOUT_MS, confirms: 0 };
  await setOp(op);
  armTimeout(op);
  return { status: "started" };
}

// A page in our tab finished loading: inject the content scripts, but only on
// the logout endpoint of the configured server.
async function onTabLoaded(tabId, tabUrl) {
  const op = await getOp();
  if (!op || op.tabId !== tabId) return;
  // Chromium hides URLs outside the granted host and may report about:blank
  // first; the timeout covers a page that never becomes the logout endpoint.
  if (!tabUrl || tabUrl === "about:blank") return;
  if (!KcConfig.isLogoutPage(tabUrl, op.url)) {
    await fail(op, "the server opened an unexpected page");
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/page.js", "content/auto-confirm.js"],
    });
  } catch (err) {
    // Typically Chromium's own error page: host unreachable, TLS error, etc.
    await fail(op, "the Keycloak page could not be opened");
  }
}

// The content script reports what the page is; the reply tells it whether to
// click the confirm button.
async function onPage(tabId, kind) {
  const op = await getOp();
  if (!op || op.tabId !== tabId) return { click: false };
  switch (kind) {
    case "confirm":
      if (op.confirms >= MAX_CONFIRMS) {
        await fail(op, "Keycloak keeps asking to confirm");
        return { click: false };
      }
      op.confirms += 1;
      await setOp(op);
      return { click: true };
    case "logged-out":
      await succeed(op);
      return { click: false };
    case "error":
      await fail(op, "Keycloak showed an error");
      return { click: false };
    default:
      await fail(op, "the page was not recognized as Keycloak logout");
      return { click: false };
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  serial(() => onTabLoaded(tabId, tab.url || ""));
});

// The user closed the tab themselves: drop the operation without a message.
chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    const op = await getOp();
    if (op && op.tabId === tabId) await finish();
  });
});

// True for the extension's own pages, whether the popup is
// shown from the toolbar or opened in a regular tab; false for content scripts.
function fromExtensionPage(sender) {
  return typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "logout" && fromExtensionPage(sender)) {
    serial(start).then(sendResponse, () => sendResponse({ status: "error" }));
    return true;
  }
  if (msg.type === "settings-saved" && fromExtensionPage(sender)) {
    const attemptId = typeof msg.id === "string" && msg.id ? msg.id : null;
    serial(() => reconcileSettings(attemptId)).then(sendResponse, () =>
      sendResponse({ status: "error" })
    );
    return true;
  }
  if (msg.type === "logout-page" && sender.tab && !fromExtensionPage(sender)) {
    serial(() => onPage(sender.tab.id, msg.kind)).then(sendResponse, () =>
      sendResponse({ click: false })
    );
    return true;
  }
});

// The user allowed access in the browser's prompt. The popup that asked may be
// gone by now (it closes when it loses focus), so finish its save here. Grants
// made without a pending save are left alone.
chrome.permissions.onAdded.addListener(() => {
  serial(async () => {
    const key = KcConfig.PENDING_KEY;
    if ((await chrome.storage.session.get(key))[key]) await reconcileSettings();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes.host || changes.realm)) serial(() => reconcileSettings());
  // A hand-over that lands after the grant event (the page starts the write
  // just before asking, without waiting for it) is saved when it appears.
  const pending = changes[KcConfig.PENDING_KEY];
  if (area === "session" && pending && pending.newValue) serial(() => reconcileSettings());
});

// Reconcile grants on upgrade/restart, and resume any pending logout timeout.
serial(async () => {
  await reconcileSettings();
  armTimeout(await getOp());
});
