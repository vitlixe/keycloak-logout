// Recognizes the pages Keycloak shows during logout. Injected into the logout
// tab before auto-confirm.js; also loaded by the tests with require().
//
// Markup follows Keycloak's base login theme:
//   logout-confirm.ftl  <form action=".../logout/logout-confirm" method="POST">
//                       with hidden "session_code" and submit "confirmLogout"
//                       (id "kc-logout"); the page also has #kc-info-message.
//   info.ftl            #kc-info-message  ("You are logged out")
//   error.ftl           #kc-error-message
(function (root) {
  // The confirmation form posts to <logout endpoint>/logout-confirm.
  function expectedConfirmAction(pageUrl) {
    let url;
    try {
      url = new URL(pageUrl);
    } catch (e) {
      return null;
    }
    const m = url.pathname.match(
      /^(.*\/realms\/[^/]+\/protocol\/openid-connect\/logout)(?:\/logout-confirm)?\/?$/
    );
    return m ? url.origin + m[1] + "/logout-confirm" : null;
  }

  function elementsOf(form) {
    return Array.from(form.elements || []);
  }

  function isConfirmMarker(el) {
    return el.name === "session_code" || el.name === "confirmLogout" || el.id === "kc-logout";
  }

  // The confirm button of the Keycloak logout form, or null. Only a POST form
  // that goes to this realm's logout-confirm endpoint and carries the
  // session_code is accepted; any other form on the page is never submitted.
  function findConfirmButton(doc, pageUrl) {
    const expected = expectedConfirmAction(pageUrl);
    if (!expected) return null;
    for (const form of Array.from(doc.forms || [])) {
      if (String(form.method || "").toLowerCase() !== "post") continue;
      let action;
      try {
        action = new URL(form.action, pageUrl);
      } catch (e) {
        continue;
      }
      if (action.origin + action.pathname !== expected) continue;
      const els = elementsOf(form);
      if (!els.some((el) => el.name === "session_code")) continue;
      const submits = els.filter((el) => el.type === "submit");
      const named = submits.find((el) => el.name === "confirmLogout" || el.id === "kc-logout");
      if (named) return named;
      if (submits.length === 1) return submits[0];
    }
    return null;
  }

  // Returns { kind, button? } where kind is:
  //   "confirm"    — the logout confirmation form; button is its submit control
  //   "logged-out" — Keycloak's info page with no confirmation form on it
  //   "error"      — Keycloak's error page
  //   "unknown"    — anything else, including a confirmation form that does not
  //                  look exactly like Keycloak's
  function classify(doc, pageUrl) {
    const button = findConfirmButton(doc, pageUrl);
    if (button) return { kind: "confirm", button };

    // The confirmation page also contains #kc-info-message, so a page that has
    // any part of the confirmation form must never count as "logged out".
    const hasConfirmMarkers =
      !!doc.getElementById("kc-logout") ||
      Array.from(doc.forms || []).some((form) => elementsOf(form).some(isConfirmMarker));
    if (hasConfirmMarkers) return { kind: "unknown" };

    if (doc.getElementById("kc-error-message")) return { kind: "error" };
    if (doc.getElementById("kc-info-message")) return { kind: "logged-out" };
    return { kind: "unknown" };
  }

  const api = { classify };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KcLogoutPage = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
