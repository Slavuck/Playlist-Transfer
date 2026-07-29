import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLoopbackRequest,
  createLocalSession,
  requireCsrf,
  requireLocalRead,
  sessionCookie,
} from "../../packages/security/src/loopback-session";

test("loopback guard rejects localhost aliases, LAN hosts and forged origins", () => {
  assert.throws(() => assertLoopbackRequest(new Request("http://localhost:3210/api/session")), /LOOPBACK_ONLY/);
  assert.throws(() => assertLoopbackRequest(new Request("http://192.168.1.3:3210/api/session")), /LOOPBACK_ONLY/);
  assert.throws(
    () => assertLoopbackRequest(new Request("http://127.0.0.1:3210/api/profile", { method: "POST", headers: { origin: "https://evil.test" } }), { mutation: true }),
    /INVALID_ORIGIN/,
  );
});

test("loopback guard trusts the exact external Host when Next normalizes its internal Request URL", () => {
  assert.doesNotThrow(() => assertLoopbackRequest(new Request("http://localhost:3210/api/session", {
    headers: { host: "127.0.0.1:3210" },
  })));
  assert.throws(() => assertLoopbackRequest(new Request("http://127.0.0.1:3210/api/session", {
    headers: { host: "localhost:3210" },
  })), /INVALID_HOST/);
});

test("local reads require both the session cookie and short-lived nonce", () => {
  const session = createLocalSession();
  const cookie = sessionCookie(session).split(";")[0];
  const valid = new Request("http://127.0.0.1:3210/api/transfers", {
    headers: { cookie, "x-playlist-transfer-nonce": session.csrf },
  });
  assert.equal(requireLocalRead(valid).id, session.id);
  assert.throws(
    () => requireLocalRead(new Request("http://127.0.0.1:3210/api/transfers", { headers: { cookie } })),
    /SESSION_NONCE_REJECTED/,
  );
});

test("CSRF requires the HttpOnly session cookie and matching header", () => {
  const session = createLocalSession();
  const cookie = sessionCookie(session).split(";")[0];
  const valid = new Request("http://127.0.0.1:3210/api/profile", {
    method: "POST",
    headers: { origin: "http://127.0.0.1:3210", cookie, "x-playlist-transfer-csrf": session.csrf },
  });
  assert.equal(requireCsrf(valid).id, session.id);
  const invalid = new Request("http://127.0.0.1:3210/api/profile", {
    method: "POST",
    headers: { origin: "http://127.0.0.1:3210", cookie, "x-playlist-transfer-csrf": "wrong" },
  });
  assert.throws(() => requireCsrf(invalid), /CSRF_REJECTED/);
});
