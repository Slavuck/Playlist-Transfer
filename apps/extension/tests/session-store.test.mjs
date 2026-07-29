import assert from "node:assert/strict";
import test from "node:test";
import { SessionRepository } from "../src/session-store.js";
import { MemoryStorageArea } from "./helpers.mjs";

async function pairedRepository(now = 1_000_000) {
  const storage = new MemoryStorageArea();
  const repository = new SessionRepository(storage);
  const invite = await repository.createPairingInvite(now);
  const session = await repository.claimPairingInvite(invite.pairingId, invite.claimSecret, now + 1);
  return { storage, repository, session, now: now + 1 };
}

test("pairing is one-time and raw pairing/session secrets are not retained", async () => {
  const storage = new MemoryStorageArea();
  const repository = new SessionRepository(storage);
  const invite = await repository.createPairingInvite(100);
  const session = await repository.claimPairingInvite(invite.pairingId, invite.claimSecret, 101);
  await assert.rejects(
    repository.claimPairingInvite(invite.pairingId, invite.claimSecret, 102),
    { code: "PAIR_ALREADY_CLAIMED" },
  );
  const raw = JSON.stringify(storage.data);
  assert.doesNotMatch(raw, new RegExp(invite.claimSecret, "u"));
  assert.doesNotMatch(raw, new RegExp(session.sessionSecret, "u"));
});

test("authenticated request IDs are replay protected", async () => {
  const { repository, session, now } = await pairedRepository();
  const auth = { sessionId: session.sessionId, sessionSecret: session.sessionSecret };
  await repository.acceptAuthenticatedRequest(auth, "request_abcdefghijklmnop", now + 1);
  await assert.rejects(
    repository.acceptAuthenticatedRequest(auth, "request_abcdefghijklmnop", now + 2),
    { code: "REQUEST_REPLAYED" },
  );
  await assert.rejects(
    repository.acceptAuthenticatedRequest(
      { sessionId: session.sessionId, sessionSecret: "z".repeat(43) },
      "request_different_value",
      now + 3,
    ),
    { code: "AUTH_FAILED" },
  );
});

test("private handoff is encrypted at rest, survives worker recreation, and is claimed once", async () => {
  const { storage, repository, session, now } = await pairedRepository();
  const privateUrl =
    "https://soundcloud.com/demo/private-track/s-AbCdEf12?secret_token=s-super-secret";
  const created = await repository.createHandoff(
    {
      schemaVersion: 1,
      provider: "soundcloud",
      resourceKind: "track",
      canonicalUrl: privateUrl,
      redactedDisplayUrl: "https://soundcloud.com/demo/private-track/s-REDACTED",
      containsSecret: true,
      capturedAtMs: now,
      evidence: { domRead: false },
    },
    now,
  );
  assert.doesNotMatch(JSON.stringify(storage.data), /s-super-secret|s-AbCdEf12/u);

  const resumedRepository = new SessionRepository(storage);
  const claimed = await resumedRepository.claimHandoff(created.handoffId, session.sessionId, now + 1);
  assert.equal(claimed.canonicalUrl, privateUrl);
  assert.equal(claimed.handoffId, created.handoffId);
  assert.doesNotMatch(JSON.stringify(storage.data), /s-super-secret|s-AbCdEf12/u);
  await assert.rejects(
    resumedRepository.claimHandoff(created.handoffId, session.sessionId, now + 2),
    { code: "HANDOFF_ALREADY_CLAIMED" },
  );
});

test("concurrent handoff claims have exactly one winner", async () => {
  const { repository, session, now } = await pairedRepository();
  const created = await repository.createHandoff(
    {
      schemaVersion: 1,
      provider: "youtube",
      resourceKind: "video",
      videoId: "dQw4w9WgXcQ",
      canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      redactedDisplayUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      containsSecret: false,
      capturedAtMs: now,
      evidence: { domRead: false },
    },
    now,
  );
  const results = await Promise.allSettled([
    repository.claimHandoff(created.handoffId, session.sessionId, now + 1),
    repository.claimHandoff(created.handoffId, session.sessionId, now + 1),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("private SoundCloud navigation is encrypted until an explicit popup consume", async () => {
  const { storage, repository, session, now } = await pairedRepository();
  const privateUrl = "https://soundcloud.com/demo/track/s-AbCdEf12";
  const intent = await repository.stageNavigation(
    {
      provider: "soundcloud",
      action: "permalink",
      purpose: "MANUAL_ADD",
      url: privateUrl,
      containsSecret: true,
      redactedDisplayUrl: "https://soundcloud.com/demo/track/s-REDACTED",
    },
    session.sessionId,
    now,
  );
  assert.doesNotMatch(JSON.stringify(storage.data), /s-AbCdEf12/u);
  const consumed = await repository.consumeNavigationIntent(intent.navigationId, now + 1);
  assert.equal(consumed.url, privateUrl);
  assert.doesNotMatch(JSON.stringify(storage.data), /s-AbCdEf12/u);
});

test("expired handoff fails closed", async () => {
  const { repository, session, now } = await pairedRepository();
  const created = await repository.createHandoff(
    {
      schemaVersion: 1,
      provider: "spotify",
      resourceKind: "track",
      canonicalUrl: "https://open.spotify.com/track/0123456789ABCDEFGHIJKL",
      redactedDisplayUrl: "https://open.spotify.com/track/0123456789ABCDEFGHIJKL",
      containsSecret: false,
      capturedAtMs: now,
      evidence: { domRead: false },
    },
    now,
  );
  await assert.rejects(
    repository.claimHandoff(created.handoffId, session.sessionId, now + 300_001),
    { code: "HANDOFF_EXPIRED" },
  );
});

