const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const KcConfig = require("../extension/common/config.js");

function element(id) {
  const classes = new Set();
  return {
    id, value: "", textContent: "", checked: false, disabled: false, listeners: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
    },
    addEventListener(event, fn) { this.listeners[event] = fn; },
    focus() {},
  };
}

function screen({ saveResult = { status: "permission-denied" }, logoutStatus = "permission-required" } = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, element(id));
    return nodes.get(id);
  };
  let saves = 0;
  const body = element("body");
  const context = vm.createContext({
    KcConfig,
    KcAccess: {
      save: () => { saves++; return Promise.resolve(saveResult); },
      messageFor: (status) => status === "permission-denied" ? "Access was not granted" : "Save settings and allow access",
    },
    document: { body, getElementById: node, addEventListener: () => {} },
    chrome: {
      storage: { sync: { get: (defaults, cb) => cb({ ...defaults, host: "auth.example.com", realm: "master" }) } },
      runtime: { sendMessage: async () => ({ status: logoutStatus }) },
    },
    setTimeout: () => 1,
    clearTimeout() {},
    window: { close() { throw new Error("The popup must stay open"); } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/popup/popup.js"), "utf8"), context);
  node("host").value = "auth.example.com";
  node("realm").value = "master";
  body.classList.add("settings-open");
  return { node, body, saves: () => saves };
}

test("popup: denied permission shows a readable error instead of Saved", async () => {
  const ui = screen();
  await ui.node("settings-save").listeners.click();
  assert.equal(ui.node("settings-save").textContent, "Not saved");
  assert.equal(ui.node("settings-save").disabled, false);
  assert.match(ui.node("settings-status").textContent, /not granted/);
  assert.ok(ui.body.classList.contains("settings-open"));
});

test("popup: repeated clicks while permission is pending start one request", async () => {
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const ui = screen({ saveResult: pending });
  const first = ui.node("settings-save").listeners.click();
  assert.equal(ui.node("settings-save").disabled, true);
  await ui.node("settings-save").listeners.click();
  assert.equal(ui.saves(), 1);
  resolve({ status: "saved" });
  await first;
  assert.equal(ui.node("settings-save").textContent, "Saved");
  assert.equal(ui.node("settings-save").disabled, false);
});

test("popup: missing access opens settings with guidance and no completion screen", async () => {
  const ui = screen();
  ui.body.classList.remove("settings-open");
  await ui.node("logout").listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ui.body.classList.contains("settings-open"));
  assert.equal(ui.body.classList.contains("bye"), false);
  assert.match(ui.node("settings-status").textContent, /allow access/);
  assert.equal(ui.saves(), 0);
});
