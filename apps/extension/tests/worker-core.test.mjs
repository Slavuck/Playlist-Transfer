import assert from "node:assert/strict";
import test from "node:test";
import { SessionRepository } from "../src/session-store.js";
import { GuidedWorkerCore } from "../src/worker-core.js";
import {
  externalSender,
  internalSender,
  makeMessage,
  MemoryStorageArea,
  MockTabs,
} from "./helpers.mjs";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

function fixture(url, initialNow = 2_000_000) {
  let now = initialNow;
  const storage = new MemoryStorageArea();
  const repository = new SessionRepository(storage);
  const tabs = new MockTabs(url);
  const core = new GuidedWorkerCore({
    repository,
    tabs,
    runtimeId: EXTENSION_ID,
    extensionVersion: "1.0.0",
    now: () => now,
  });
  return {
    storage,
    repository,
    tabs,
    core,
    get now() {
      return now;
    },
    set now(value) {
      now = value;
    },
  };
}

async function pair(fx) {
  const invite = await fx.repository.createPairingInvite(fx.now);
  return fx.repository.claimPairingInvite(invite.pairingId, invite.claimSecret, fx.now);
}

test("popup captures a fresh activeTab URL and returns honest URL-only evidence", async () => {
  const fx = fixture("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  const session = await pair(fx);
  const context = await fx.core.handleInternal(
    makeMessage("POPUP_CONTEXT_GET", {}, { issuedAtMs: fx.now }),
    internalSender(EXTENSION_ID),
  );
  assert.equal(context.ok, true);
  assert.equal(context.data.resource.videoId, "dQw4w9WgXcQ");

  const capture = await fx.core.handleInternal(
    makeMessage(
      "CAPTURE_PROVIDER_URL",
      { contextId: context.data.contextId, mode: "resource" },
      { issuedAtMs: fx.now },
    ),
    internalSender(EXTENSION_ID),
  );
  assert.equal(capture.ok, true);

  const claimed = await fx.repository.claimHandoff(
    capture.data.handoffId,
    session.sessionId,
    fx.now + 1,
  );
  assert.equal(claimed.videoId, "dQw4w9WgXcQ");
  assert.deepEqual(claimed.evidence, {
    method: "USER_GESTURE_ACTIVE_TAB_URL",
    officialOriginConfirmed: true,
    idSyntaxConfirmed: true,
    domRead: false,
    providerReadBack: false,
    ownerVerified: false,
    writeAccessVerified: false,
  });
  assert.equal(Object.hasOwn(claimed, "title"), false);
});

test("service-tab capture hands off a canonical profile URL and rejects non-profile pages", async () => {
  const fx = fixture("https://music.youtube.com/@demo-channel?feature=shared");
  const session = await pair(fx);
  const context = await fx.core.handleInternal(
    makeMessage("POPUP_CONTEXT_GET", {}, { issuedAtMs: fx.now }),
    internalSender(EXTENSION_ID),
  );
  assert.equal(context.ok, true);
  assert.equal(context.data.serviceTabEligible, true);
  const capture = await fx.core.handleInternal(
    makeMessage(
      "CAPTURE_PROVIDER_URL",
      { contextId: context.data.contextId, mode: "service-tab" },
      { issuedAtMs: fx.now },
    ),
    internalSender(EXTENSION_ID),
  );
  assert.equal(capture.ok, true);
  const claimed = await fx.repository.claimHandoff(capture.data.handoffId, session.sessionId, fx.now + 1);
  assert.equal(claimed.resourceKind, "service-tab");
  assert.equal(claimed.canonicalUrl, "https://www.youtube.com/@demo-channel");

  const nonProfile = fixture("https://www.youtube.com/feed/subscriptions", fx.now);
  await pair(nonProfile);
  const nonProfileContext = await nonProfile.core.handleInternal(
    makeMessage("POPUP_CONTEXT_GET", {}, { issuedAtMs: nonProfile.now }),
    internalSender(EXTENSION_ID),
  );
  assert.equal(nonProfileContext.data.serviceTabEligible, false);
  const rejected = await nonProfile.core.handleInternal(
    makeMessage(
      "CAPTURE_PROVIDER_URL",
      { contextId: nonProfileContext.data.contextId, mode: "service-tab" },
      { issuedAtMs: nonProfile.now },
    ),
    internalSender(EXTENSION_ID),
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "UNSUPPORTED_PROFILE_TAB");
});

test("tab swap between popup preview and capture fails closed", async () => {
  const fx = fixture("https://open.spotify.com/track/0123456789ABCDEFGHIJKL");
  await pair(fx);
  const context = await fx.core.handleInternal(
    makeMessage("POPUP_CONTEXT_GET", {}, { issuedAtMs: fx.now }),
    internalSender(EXTENSION_ID),
  );
  fx.tabs.activeTab.url = "https://open.spotify.com/track/ZYXWVUTSRQPONMLKJIHGFE";
  const capture = await fx.core.handleInternal(
    makeMessage(
      "CAPTURE_PROVIDER_URL",
      { contextId: context.data.contextId, mode: "resource" },
      { issuedAtMs: fx.now },
    ),
    internalSender(EXTENSION_ID),
  );
  assert.equal(capture.ok, false);
  assert.equal(capture.error.code, "TAB_CHANGED");
});

test("external navigation only stages; a later internal popup click opens it", async () => {
  const fx = fixture("https://www.youtube.com/");
  const session = await pair(fx);
  const auth = { sessionId: session.sessionId, sessionSecret: session.sessionSecret };
  const staged = await fx.core.handleExternal(
    makeMessage(
      "NAVIGATION_STAGE",
      {
        target: { provider: "youtube", action: "search", query: "artist title" },
        purpose: "SEARCH_CANDIDATE",
      },
      { auth, issuedAtMs: fx.now },
    ),
    externalSender(),
  );
  assert.equal(staged.ok, true);
  assert.equal(staged.data.requiresPopupConfirmation, true);
  assert.equal(fx.tabs.created.length, 0);

  const opened = await fx.core.handleInternal(
    makeMessage(
      "NAVIGATION_OPEN",
      { navigationId: staged.data.navigationId },
      { issuedAtMs: fx.now },
    ),
    internalSender(EXTENSION_ID),
  );
  assert.equal(opened.ok, true);
  assert.deepEqual(fx.tabs.created, [
    { url: "https://www.youtube.com/results?search_query=artist+title", active: true },
  ]);
});

test("external origin and replay protections are applied before handoff", async () => {
  const fx = fixture("https://www.youtube.com/");
  const hello = makeMessage("EXT_HELLO", { clientVersion: "1.0.0" }, { issuedAtMs: fx.now });
  const wrong = await fx.core.handleExternal(
    hello,
    externalSender({ origin: "http://localhost:3210" }),
  );
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, "WRONG_SENDER_ORIGIN");

  const session = await pair(fx);
  const auth = { sessionId: session.sessionId, sessionSecret: session.sessionSecret };
  const request = makeMessage(
    "NAVIGATION_STAGE",
    {
      target: { provider: "youtube", action: "video", videoId: "dQw4w9WgXcQ" },
      purpose: "MANUAL_ADD",
    },
    { auth, issuedAtMs: fx.now },
  );
  const first = await fx.core.handleExternal(request, externalSender());
  const replay = await fx.core.handleExternal(request, externalSender());
  assert.equal(first.ok, true);
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, "REQUEST_REPLAYED");
});

test("external messages cannot masquerade as extension popup messages", async () => {
  const fx = fixture("https://www.youtube.com/");
  const response = await fx.core.handleInternal(
    makeMessage("SESSION_CLEAR", {}, { issuedAtMs: fx.now }),
    internalSender("differentdifferentdifferentdiffe"),
  );
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "WRONG_INTERNAL_SENDER");
});
