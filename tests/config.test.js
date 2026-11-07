const test = require("node:test");
const assert = require("node:assert/strict");
const KcConfig = require("../extension/common/config.js");

test("parseHost normalizes the server address", () => {
  const cases = [
    ["auth.example.com", "auth.example.com"],
    ["  https://auth.example.com/  ", "auth.example.com"],
    ["http://auth.example.com", "auth.example.com"],
    ["auth.example.com:8443", "auth.example.com:8443"],
    ["auth.example.com/auth/", "auth.example.com/auth"],
    ["AUTH.Example.com", "auth.example.com"],
  ];
  for (const [input, want] of cases) {
    assert.deepEqual(KcConfig.parseHost(input), { value: want }, input);
  }
});

test("parseHost rejects values that are not a server address", () => {
  for (const input of [
    "",
    "   ",
    "user:pass@auth.example.com",
    "auth.example.com?x=1",
    "auth.example.com#frag",
    "auth.example.com/realms/master",
    "https://auth.example.com/realms/master/protocol/openid-connect/logout",
    "exa mple.com",
    "ftp://auth.example.test",
    "file:///etc/passwd",
    "javascript://auth.example.com",
    "auth.example.com//auth",
  ]) {
    assert.ok(KcConfig.parseHost(input).error, JSON.stringify(input));
  }
});

test("parseHost names the problem with another scheme", () => {
  assert.deepEqual(KcConfig.parseHost("ftp://auth.example.test"), {
    error: "Only https:// addresses are supported",
  });
});

test("parseRealm accepts names that fit one path segment", () => {
  assert.deepEqual(KcConfig.parseRealm(" master "), { value: "master" });
  assert.deepEqual(KcConfig.parseRealm("team#east"), { value: "team#east" });
  for (const input of ["", "a/b", "a\\b", ".", ".."]) {
    assert.ok(KcConfig.parseRealm(input).error, JSON.stringify(input));
  }
});

test("validate returns clean settings or per-field errors", () => {
  assert.deepEqual(
    KcConfig.validate({ host: "https://auth.example.com/", realm: " master ", notify: false }),
    { cfg: { host: "auth.example.com", realm: "master", notify: false } }
  );
  assert.deepEqual(KcConfig.validate({ host: "", realm: "" }), {
    errors: { host: "Required", realm: "Required" },
  });
});

test("buildLogoutUrl encodes the realm", () => {
  assert.equal(
    KcConfig.buildLogoutUrl({ host: "auth.example.com", realm: "master" }),
    "https://auth.example.com/realms/master/protocol/openid-connect/logout"
  );
  const url = KcConfig.buildLogoutUrl({ host: "auth.example.com/auth", realm: "team#east" });
  assert.equal(
    url,
    "https://auth.example.com/auth/realms/team%23east/protocol/openid-connect/logout"
  );
  // The realm stays in the path instead of turning into a URL fragment.
  assert.equal(new URL(url).hash, "");
});

test("isLogoutPage accepts only the configured logout endpoint", () => {
  const base = "https://auth.example.com/realms/master/protocol/openid-connect/logout";
  assert.ok(KcConfig.isLogoutPage(base, base));
  assert.ok(KcConfig.isLogoutPage(base + "?x=1", base));
  assert.ok(KcConfig.isLogoutPage(base + "/logout-confirm", base));
  assert.ok(!KcConfig.isLogoutPage(base + "-other", base));
  assert.ok(!KcConfig.isLogoutPage("https://evil.example.com/realms/master/protocol/openid-connect/logout", base));
  assert.ok(!KcConfig.isLogoutPage("https://auth.example.com/realms/other/protocol/openid-connect/logout", base));
  assert.ok(!KcConfig.isLogoutPage("", base));
  assert.ok(!KcConfig.isLogoutPage("chrome-error://chromewebdata/", base));
});

test("host permissions never include a port, path prefix or wildcard subdomain", () => {
  for (const [host, expected] of [
    ["auth.example.com", "https://auth.example.com/*"],
    ["auth.example.com:8443/auth", "https://auth.example.com/*"],
    ["localhost:8443", "https://localhost/*"],
    ["[::1]:8443/auth", "https://[::1]/*"],
  ]) {
    assert.equal(KcConfig.permissionOrigin({ host, realm: "master" }), expected);
  }
});
