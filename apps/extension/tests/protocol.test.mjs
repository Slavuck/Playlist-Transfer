import assert from "node:assert/strict";
import test from "node:test";
import { LIMITS } from "../src/constants.js";
import {
  assertExternalSender,
  assertFreshRequest,
  validateExternalMessage,
} from "../src/protocol.js";
import { externalSender, makeMessage } from "./helpers.mjs";

test("external sender must match literal loopback scheme, host, port, path and top frame", () => {
  assert.doesNotThrow(() => assertExternalSender(externalSender()));
  const invalidSenders = [
    externalSender({ origin: "http://localhost:3210" }),
    externalSender({ origin: "http://127.0.0.1:3000" }),
    externalSender({ url: "http://127.0.0.1:3210/extension-bridge/extra" }),
    externalSender({ url: "http://127.0.0.1:3210/extension-bridge?x=1" }),
    externalSender({ frameId: 2 }),
    externalSender({ documentLifecycle: "prerender" }),
    externalSender({ id: "anotherextensionid" }),
  ];
  for (const sender of invalidSenders) {
    assert.throws(() => assertExternalSender(sender), { code: "WRONG_SENDER_ORIGIN" });
  }
});

test("external message schemas reject unknown keys and malformed navigation unions", () => {
  const hello = makeMessage("EXT_HELLO", { clientVersion: "1.0.0" });
  assert.equal(validateExternalMessage(hello).type, "EXT_HELLO");

  assert.throws(
    () => validateExternalMessage({ ...hello, unexpected: true }),
    { code: "BAD_SCHEMA" },
  );

  const navigation = makeMessage(
    "NAVIGATION_STAGE",
    {
      purpose: "SEARCH_CANDIDATE",
      target: { provider: "youtube", action: "search", query: "test" },
    },
    { auth: { sessionId: "a".repeat(22), sessionSecret: "b".repeat(43) } },
  );
  assert.equal(validateExternalMessage(navigation).body.target.provider, "youtube");
  navigation.body.target.evil = "https://evil.test";
  assert.throws(() => validateExternalMessage(navigation), { code: "BAD_SCHEMA" });
});

test("message and timestamp limits are enforced", () => {
  const huge = makeMessage("EXT_HELLO", { clientVersion: "x".repeat(LIMITS.messageBytes) });
  assert.throws(() => validateExternalMessage(huge), { code: "PAYLOAD_TOO_LARGE" });

  const now = 1_000_000;
  assert.doesNotThrow(() => assertFreshRequest(now, now));
  assert.throws(() => assertFreshRequest(now - 31_000, now), { code: "REQUEST_EXPIRED" });
  assert.throws(() => assertFreshRequest(now + 6_000, now), { code: "REQUEST_EXPIRED" });
});

