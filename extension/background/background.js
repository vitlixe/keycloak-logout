// Opens the Keycloak logout page in a background tab, auto-confirms the logout,
// closes the tab and (optionally) shows a notification. Acts only on tabs the
// extension opened itself; normal user navigation to a logout page is untouched.

// Tab ids we opened ourselves for logout.
const managedTabs = new Set();

// Logout page URL pattern.
const LOGOUT_URL =
  /^https:\/\/[^/]+\/realms\/[^/]+\/protocol\/openid-connect\/logout/;

// Close with retries: Chromium may report the tab is being dragged.
function closeTab(id, attempt = 0) {
  chrome.tabs.remove(id).catch(() => {
    if (attempt < 10) {
      setTimeout(() => closeTab(id, attempt + 1), 250);
    }
  });
}

function notifyLoggedOut() {
  chrome.storage.sync.get({ notify: true }, (cfg) => {
    if (!cfg.notify) return;
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "Keycloak Logout",
      message: "You have logged out of the SSO session",
    });
  });
}

function startLogout(url) {
  chrome.tabs.create({ url, active: false }).then(
    (tab) => {
      if (tab && tab.id != null) managedTabs.add(tab.id);
    },
    (err) => {
      console.warn("Keycloak Logout: failed to open logout tab", err);
    }
  );
}

// Inject auto-confirm only into our own tabs, only on the logout page, and only
// after it finished loading so the server confirm form is rendered. Submitting
// it reloads the tab, which fires onUpdated again and re-injects on the new page.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!managedTabs.has(tabId)) return;
  if (!LOGOUT_URL.test(tab.url || "")) return;
  chrome.scripting
    .executeScript({ target: { tabId }, files: ["content/auto-confirm.js"] })
    .catch(() => {});
});

// Drop a tab from tracking if it was closed elsewhere.
chrome.tabs.onRemoved.addListener((tabId) => managedTabs.delete(tabId));

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "logout") {
    startLogout(msg.url);
  } else if (msg && msg.type === "logout-done") {
    const tabId = sender.tab && sender.tab.id;
    // Close and notify only for our tabs, and only once logout is confirmed.
    if (tabId != null && managedTabs.has(tabId)) {
      managedTabs.delete(tabId);
      closeTab(tabId);
      notifyLoggedOut();
    }
  }
});
