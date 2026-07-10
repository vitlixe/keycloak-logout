// Runs in the background logout tab; injected after the page has fully loaded
// (see background.js). If a confirm form is present, submit it (the page reloads
// and the script is injected again). If none appears after waiting, this is the
// "logged out" page, so ask background to close the tab.
(function () {
  function findConfirm() {
    return (
      document.getElementById("kc-logout") ||
      document.querySelector('input[name="confirmLogout"]') ||
      document.querySelector('form input[type="submit"], form button[type="submit"]')
    );
  }

  // Button present — click and return (page will reload).
  var btn = findConfirm();
  if (btn) {
    btn.click();
    return;
  }

  // No button. Injection happens after full load, so a server confirm form would
  // already be here — its absence almost certainly means the "logged out" page.
  // Still poll a bit in case of late client-side rendering before we finish.
  var tries = 0;
  var timer = setInterval(function () {
    var b = findConfirm();
    if (b) {
      clearInterval(timer);
      b.click();
    } else if (++tries >= 12) { // ~1.2s
      clearInterval(timer);
      chrome.runtime.sendMessage({ type: "logout-done" });
    }
  }, 100);
})();
