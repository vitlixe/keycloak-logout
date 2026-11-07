// Page recognition on minimal DOM stand-ins shaped like Keycloak's base theme.
const test = require("node:test");
const assert = require("node:assert/strict");
const { classify } = require("../extension/content/page.js");

const LOGOUT = "https://auth.example.com/realms/master/protocol/openid-connect/logout";
const CONFIRM_ACTION = LOGOUT + "/logout-confirm";

function input(attrs) {
  return { type: "text", ...attrs };
}

function form({ action = CONFIRM_ACTION, method = "post", elements = [] } = {}) {
  return { action, method, elements };
}

function keycloakConfirmForm(overrides = {}) {
  return form({
    elements: [
      input({ type: "hidden", name: "session_code" }),
      input({ type: "submit", name: "confirmLogout", id: "kc-logout" }),
    ],
    ...overrides,
  });
}

// ids: element ids present on the page outside the forms.
function doc({ forms = [], ids = [] } = {}) {
  const byId = {};
  for (const id of ids) byId[id] = { id };
  for (const f of forms) for (const el of f.elements) if (el.id) byId[el.id] = el;
  return { forms, getElementById: (id) => byId[id] || null };
}

test("Keycloak confirmation page: confirm with its button", () => {
  const page = doc({ forms: [keycloakConfirmForm()], ids: ["kc-info-message"] });
  const result = classify(page, LOGOUT);
  assert.equal(result.kind, "confirm");
  assert.equal(result.button.name, "confirmLogout");
});

test("confirmation page after a language switch is still recognized", () => {
  const page = doc({ forms: [keycloakConfirmForm()], ids: ["kc-info-message"] });
  assert.equal(classify(page, CONFIRM_ACTION + "?kc_locale=ru").kind, "confirm");
});

test("confirmation page under the /auth prefix", () => {
  const url = "https://auth.example.com/auth/realms/master/protocol/openid-connect/logout";
  const page = doc({ forms: [keycloakConfirmForm({ action: url + "/logout-confirm" })] });
  assert.equal(classify(page, url).kind, "confirm");
});

test("logged-out page: success", () => {
  assert.deepEqual(classify(doc({ ids: ["kc-info-message"] }), CONFIRM_ACTION), {
    kind: "logged-out",
  });
});

test("error page: error, never success", () => {
  assert.deepEqual(classify(doc({ ids: ["kc-error-message"] }), LOGOUT), { kind: "error" });
});

test("empty or foreign page (e.g. 404 for a wrong realm): unknown, never success", () => {
  assert.deepEqual(classify(doc(), LOGOUT), { kind: "unknown" });
});

test("foreign form with a submit button is never clicked", () => {
  const foreign = form({
    action: "https://auth.example.com/some/other/action",
    elements: [input({ name: "q" }), input({ type: "submit", name: "go" })],
  });
  const result = classify(doc({ forms: [foreign] }), LOGOUT);
  assert.equal(result.kind, "unknown");
  assert.equal(result.button, undefined);
});

test("confirmation-like forms that do not match exactly are not clicked", () => {
  const variants = {
    "another origin": keycloakConfirmForm({
      action: "https://evil.example.com/realms/master/protocol/openid-connect/logout/logout-confirm",
    }),
    "another realm": keycloakConfirmForm({
      action: "https://auth.example.com/realms/other/protocol/openid-connect/logout/logout-confirm",
    }),
    "GET method": keycloakConfirmForm({ method: "get" }),
    "no session_code": form({
      elements: [input({ type: "submit", name: "confirmLogout", id: "kc-logout" })],
    }),
    "two unnamed submits": form({
      elements: [
        input({ type: "hidden", name: "session_code" }),
        input({ type: "submit", name: "a" }),
        input({ type: "submit", name: "b" }),
      ],
    }),
  };
  for (const [name, f] of Object.entries(variants)) {
    // The page also carries #kc-info-message, as Keycloak's confirmation page does;
    // it must not be mistaken for the logged-out page.
    const result = classify(doc({ forms: [f], ids: ["kc-info-message"] }), LOGOUT);
    assert.equal(result.kind, "unknown", name);
  }
});

test("a single submit next to session_code is accepted for custom themes", () => {
  const custom = form({
    elements: [input({ type: "hidden", name: "session_code" }), input({ type: "submit", name: "ok" })],
  });
  const result = classify(doc({ forms: [custom] }), LOGOUT);
  assert.equal(result.kind, "confirm");
  assert.equal(result.button.name, "ok");
});

test("pages outside the logout endpoint are never confirmed", () => {
  const page = doc({ forms: [keycloakConfirmForm()] });
  assert.equal(classify(page, "https://auth.example.com/realms/master/account").kind, "unknown");
});
