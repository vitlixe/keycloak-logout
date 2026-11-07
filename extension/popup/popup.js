const $host = document.getElementById("host");
const $realm = document.getElementById("realm");
const $notify = document.getElementById("notify");
const $save = document.getElementById("settings-save");
const $target = document.getElementById("target");
const $doneText = document.getElementById("done-text");
const $status = document.getElementById("settings-status");
let saveTimer;

// Show the configured host above the button ("Not configured" when empty).
function showTarget(host) {
  $target.textContent = host || "Not configured";
  $target.classList.toggle("muted", !host);
}

chrome.storage.sync.get(KcConfig.DEFAULTS, (cfg) => showTarget(cfg.host));

/* ---------- settings (a second "screen" of the same popup) ---------- */

// Mark a field red and show the message under it; null clears the error.
function setError(input, message) {
  input.classList.toggle("error", !!message);
  const err = document.getElementById(input.id + "-err");
  if (err) {
    if (message) err.textContent = message;
    err.classList.toggle("show", !!message);
  }
}

function fillSettings(cfg) {
  clearTimeout(saveTimer);
  $save.classList.remove("ok", "fail");
  $save.textContent = "Save";
  $status.textContent = "";
  $status.classList.remove("error");
  $host.value = cfg.host;
  $realm.value = cfg.realm;
  $notify.checked = cfg.notify;
  // Clear error highlight — fields were reloaded from storage.
  setError($host, null);
  setError($realm, null);
}

function openSettings() {
  chrome.storage.sync.get(KcConfig.DEFAULTS, fillSettings);
  document.body.classList.add("settings-open");
}

function closeSettings() {
  document.body.classList.remove("settings-open");
}

// Highlight invalid fields and focus the first; returns the clean settings or
// null.
function validateForm() {
  const { cfg, errors = {} } = KcConfig.validate({
    host: $host.value,
    realm: $realm.value,
    notify: $notify.checked,
  });
  setError($host, errors.host);
  setError($realm, errors.realm);
  if (errors.host) $host.focus();
  else if (errors.realm) $realm.focus();
  return cfg || null;
}

[$host, $realm].forEach((el) =>
  el.addEventListener("input", () => {
    setError(el, null);
    $status.textContent = "";
  })
);

async function saveSettings() {
  if ($save.disabled) return;
  const cfg = validateForm();
  if (!cfg) return;
  clearTimeout(saveTimer);
  $save.classList.remove("ok", "fail");
  $save.textContent = "Save";
  $status.textContent = "";
  $save.disabled = true;
  try {
    // Request directly from the click, before any asynchronous storage work.
    const result = await KcAccess.save(cfg);
    if (!result || result.status !== "saved") {
      throw new Error(KcAccess.messageFor(result && result.status));
    }
    $host.value = cfg.host;
    $realm.value = cfg.realm;
    showTarget(cfg.host);
    // Button turns into a green "Saved", then reverts.
    $save.classList.add("ok");
    $save.textContent = "Saved";
    saveTimer = setTimeout(() => {
      $save.classList.remove("ok");
      $save.textContent = "Save";
      closeSettings();
    }, 670);
  } catch (err) {
    $save.classList.add("fail");
    $save.textContent = "Not saved";
    $status.classList.add("error");
    $status.textContent = err.message || KcAccess.messageFor("error");
    saveTimer = setTimeout(() => {
      $save.classList.remove("fail");
      $save.textContent = "Save";
    }, 2000);
  } finally {
    $save.disabled = false;
  }
}

document.getElementById("settings-open").addEventListener("click", openSettings);
document.getElementById("settings-back").addEventListener("click", closeSettings);
$save.addEventListener("click", saveSettings);

/* ---------- logout ---------- */

// Not configured (or stored settings are invalid) — open settings and
// highlight what needs fixing.
function showSettingsErrors(message = "") {
  chrome.storage.sync.get(KcConfig.DEFAULTS, (cfg) => {
    fillSettings(cfg);
    $status.textContent = message;
    document.body.classList.add("settings-open");
    validateForm();
  });
}

function showFailure() {
  $doneText.textContent = "Logout failed";
  document.body.classList.add("bye", "failed");
  setTimeout(() => window.close(), 1500);
}

document.getElementById("logout").addEventListener("click", function () {
  // The background reads the settings and builds the logout URL itself.
  chrome.runtime.sendMessage({ type: "logout" }).then((resp) => {
    const status = resp && resp.status;
    if (status === "not-configured") {
      showSettingsErrors();
      return;
    }
    if (status === "permission-required") {
      showSettingsErrors(KcAccess.messageFor(status));
      return;
    }
    if (status !== "started" && status !== "busy") {
      // "error" or no answer: the logout tab did not open.
      showFailure();
      return;
    }
    if (status === "busy") $doneText.textContent = "Logout already in progress…";
    // Later failures are reported by the background with a notification.
    document.body.classList.add("bye");
    setTimeout(() => window.close(), 1200);
  }, showFailure);
});
