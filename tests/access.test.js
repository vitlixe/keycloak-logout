const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const KcConfig = require("../extension/common/config.js");

const source = fs.readFileSync(path.join(__dirname, "../extension/common/access.js"), "utf8");
const cfg = { host: "auth.example.com:8443/auth", realm: "master", notify: true };

// The popup side: hand the settings to the background, ask for
// access inside the click, then let the background write them.
function screen({ granted = true, requestError = false, handOverError = false } = {}) {
  const calls = [];
  let hasGesture = true;
  const session = {};
  const context = vm.createContext({
    KcConfig,
    chrome: {
      permissions: {
        request: (permissions) => {
          assert.ok(hasGesture, "request must happen before yielding the click handler");
          calls.push(["request", JSON.parse(JSON.stringify(permissions))]);
          return requestError ? Promise.reject(new Error("Permission request failed")) : Promise.resolve(granted);
        },
      },
      storage: {
        session: {
          set: (value) => {
            calls.push(["hand-over"]);
            if (handOverError) return Promise.reject(new Error("Session storage failed"));
            Object.assign(session, JSON.parse(JSON.stringify(value)));
            return Promise.resolve();
          },
          remove: async (key) => {
            calls.push(["drop"]);
            delete session[key];
          },
        },
        sync: { set: async () => { throw new Error("the page must not write settings itself"); } },
      },
      runtime: { sendMessage: async (message) => {
        calls.push(["reconcile", message.type, message.id]);
        return { status: "saved" };
      } },
    },
    Date: { now: () => 42 },
    crypto: { randomUUID: () => "attempt-1" },
  });
  vm.runInContext(source, context);
  return {
    save: () => {
      const result = context.KcAccess.save(cfg);
      hasGesture = false;
      return result;
    },
    calls,
    session,
  };
}

test("hand over, request the exact host in the click, then let the background save", async () => {
  const ui = screen();
  const result = ui.save();
  // Both calls started synchronously, inside the click.
  assert.deepEqual(ui.calls, [
    ["hand-over"],
    ["request", { origins: ["https://auth.example.com/*"] }],
  ]);
  assert.deepEqual(await result, { status: "saved" });
  // The page asks for the outcome of this very attempt.
  assert.deepEqual(ui.calls.at(-1), ["reconcile", "settings-saved", "attempt-1"]);
  assert.deepEqual(ui.session.pendingSettings, { id: "attempt-1", cfg, at: 42 });
});

test("denied permission drops the hand-over and changes nothing", async () => {
  const ui = screen({ granted: false });
  assert.equal((await ui.save()).status, "permission-denied");
  assert.deepEqual(ui.calls.map(([kind]) => kind), ["hand-over", "request", "drop"]);
  assert.equal(ui.session.pendingSettings, undefined);
});

test("permission API failure never asks the background to save", async () => {
  const ui = screen({ requestError: true });
  await assert.rejects(ui.save(), /Permission request failed/);
  assert.ok(!ui.calls.some(([kind]) => kind === "reconcile"));
});

test("a failed hand-over is reported and nothing is saved", async () => {
  const ui = screen({ handOverError: true });
  await assert.rejects(ui.save(), /Session storage failed/);
  assert.ok(!ui.calls.some(([kind]) => kind === "reconcile"));
});

test("the manifest requests no host at install time", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../extension/manifest.json"), "utf8"));
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
});
