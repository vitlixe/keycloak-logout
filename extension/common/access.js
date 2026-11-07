// Saves the popup settings. Call save() directly from the click
// handler: permissions.request must run before any asynchronous work to retain
// the user gesture.
//
// The settings are handed to the background before the browser asks for
// access, and the background writes them. The browser may close the popup
// while its permission prompt is open; the save must not depend on the page
// surviving that prompt.
(function (root) {
  function save(cfg) {
    const origin = KcConfig.permissionOrigin(cfg);
    // The background reports the outcome of this very attempt by its id.
    const id = crypto.randomUUID();
    // Started, not awaited: an await here would end the click's user gesture
    // before permissions.request runs.
    const handedOver = chrome.storage.session.set({
      [KcConfig.PENDING_KEY]: { id, cfg, at: Date.now() },
    });
    handedOver.catch(() => {}); // awaited below; avoid an unhandled rejection meanwhile
    return chrome.permissions.request({ origins: [origin] }).then(async (granted) => {
      await handedOver;
      if (!granted) {
        await chrome.storage.session.remove(KcConfig.PENDING_KEY);
        return { status: "permission-denied" };
      }
      // Access already existed (no prompt) or the page survived the prompt:
      // ask the background for the result of this attempt, writing the
      // settings first if it has not done so yet. If the page did not
      // survive, the background saves them on permissions.onAdded.
      return chrome.runtime.sendMessage({ type: "settings-saved", id });
    });
  }

  function messageFor(status) {
    switch (status) {
      case "permission-denied":
        return "Access was not granted. Allow access to the Keycloak server to save these settings.";
      case "permission-required":
        return "Save settings and allow access to your Keycloak server.";
      default:
        return "Could not finish saving settings. Please try again.";
    }
  }

  root.KcAccess = { save, messageFor };
})(globalThis);
