const DEFAULTS = { host: "", realm: "", notify: true };

const $host = document.getElementById("host");
const $realm = document.getElementById("realm");
const $notify = document.getElementById("notify");
const $save = document.getElementById("save");

function cleanHost(v) {
  return (v || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

// Mark a field red and show "Required" when it is empty.
function setError(input, isError) {
  input.classList.toggle("error", isError);
  const err = document.getElementById(input.id + "-err");
  if (err) err.classList.toggle("show", isError);
}

[$host, $realm].forEach((el) =>
  el.addEventListener("input", () => setError(el, false))
);

function load() {
  chrome.storage.sync.get(DEFAULTS, (cfg) => {
    $host.value = cfg.host;
    $realm.value = cfg.realm;
    $notify.checked = cfg.notify;
  });
}

function save() {
  const host = cleanHost($host.value);
  const realm = ($realm.value || "").trim();
  setError($host, !host);
  setError($realm, !realm);
  if (!host || !realm) {
    (!host ? $host : $realm).focus();
    return;
  }
  const cfg = { host, realm, notify: $notify.checked };
  chrome.storage.sync.set(cfg, () => {
    $host.value = cfg.host;
    // Button turns into a green "Saved", then reverts.
    $save.classList.add("ok");
    $save.textContent = "Saved";
    setTimeout(() => {
      $save.classList.remove("ok");
      $save.textContent = "Save";
    }, 800);
  });
}

$save.addEventListener("click", save);
document.addEventListener("DOMContentLoaded", load);
