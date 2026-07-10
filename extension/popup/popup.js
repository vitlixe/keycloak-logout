const DEFAULTS = { host: "", realm: "", notify: true };

function buildLogoutUrl(cfg) {
  return `https://${cfg.host}/realms/${cfg.realm}/protocol/openid-connect/logout`;
}

function cleanHost(v) {
  return (v || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

const $host = document.getElementById("host");
const $realm = document.getElementById("realm");
const $notify = document.getElementById("notify");
const $save = document.getElementById("settings-save");
const $target = document.getElementById("target");

// Show the configured host above the button ("Not configured" when empty).
function showTarget(host) {
  $target.textContent = host || "Not configured";
  $target.classList.toggle("muted", !host);
}

chrome.storage.sync.get(DEFAULTS, (cfg) => showTarget(cfg.host));

/* ---------- settings (a second "screen" of the same popup) ---------- */
function fillSettings(cfg) {
  $host.value = cfg.host;
  $realm.value = cfg.realm;
  $notify.checked = cfg.notify;
  // Clear error highlight — fields were reloaded from storage.
  setError($host, false);
  setError($realm, false);
}

function openSettings() {
  chrome.storage.sync.get(DEFAULTS, fillSettings);
  document.body.classList.add("settings-open");
}

function closeSettings() {
  document.body.classList.remove("settings-open");
}

// Mark a field red and show "Required" when it is empty.
function setError(input, isError) {
  input.classList.toggle("error", isError);
  const err = document.getElementById(input.id + "-err");
  if (err) err.classList.toggle("show", isError);
}

// Highlight empty required fields, focus the first; returns true when all filled.
function validateRequired() {
  const host = cleanHost($host.value);
  const realm = ($realm.value || "").trim();
  setError($host, !host);
  setError($realm, !realm);
  const firstEmpty = !host ? $host : !realm ? $realm : null;
  if (firstEmpty) firstEmpty.focus();
  return !!host && !!realm;
}

[$host, $realm].forEach((el) =>
  el.addEventListener("input", () => setError(el, false))
);

function saveSettings() {
  if (!validateRequired()) return;
  const cfg = {
    host: cleanHost($host.value),
    realm: ($realm.value || "").trim(),
    notify: $notify.checked,
  };
  chrome.storage.sync.set(cfg, () => {
    $host.value = cfg.host;
    showTarget(cfg.host);
    // Button turns into a green "Saved", then reverts.
    $save.classList.add("ok");
    $save.textContent = "Saved";
    setTimeout(() => {
      $save.classList.remove("ok");
      $save.textContent = "Save";
      closeSettings();
    }, 670);
  });
}

document.getElementById("settings-open").addEventListener("click", openSettings);
document.getElementById("settings-back").addEventListener("click", closeSettings);
$save.addEventListener("click", saveSettings);

/* ---------- logout ---------- */
document.getElementById("logout").addEventListener("click", function () {
  chrome.storage.sync.get(DEFAULTS, (cfg) => {
    // Not configured — open settings and highlight the empty fields.
    if (!cfg.host || !cfg.realm) {
      fillSettings(cfg);
      document.body.classList.add("settings-open");
      validateRequired();
      return;
    }
    chrome.runtime.sendMessage({ type: "logout", url: buildLogoutUrl(cfg) });
    document.body.classList.add("bye");
    setTimeout(() => window.close(), 1200);
  });
});
