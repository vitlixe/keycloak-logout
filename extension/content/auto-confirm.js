// Runs in the background logout tab after page.js; injected once the page has
// fully loaded (see background.js). Reports what the page is and clicks the
// confirm button only when the background allows it. Deciding success, failure
// and retries is up to the background.
(function () {
  // One run per document: a repeated injection into the same page is ignored.
  if (window.__kcLogoutRan) return;
  window.__kcLogoutRan = true;

  function report(result) {
    chrome.runtime
      .sendMessage({ type: "logout-page", kind: result.kind })
      .then((resp) => {
        if (resp && resp.click && result.button) result.button.click();
      })
      .catch(() => {});
  }

  // The page is fully loaded, but give late client-side rendering ~1.2s before
  // reporting a page we do not recognize.
  let tries = 0;
  (function poll() {
    const result = KcLogoutPage.classify(document, location.href);
    if (result.kind !== "unknown" || ++tries >= 12) {
      report(result);
      return;
    }
    setTimeout(poll, 100);
  })();
})();
