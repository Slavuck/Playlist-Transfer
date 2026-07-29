import assert from "node:assert/strict";
import test from "node:test";
import {
  appendGuidedCapture,
  clearGuidedCaptureDraft,
  GUIDED_CAPTURE_DRAFT_KEY,
  LEGACY_GUIDED_CAPTURE_KEY,
  migrateLegacyGuidedCapture,
  readGuidedCaptureDraft,
  removeGuidedCaptures,
} from "../../app/components/guided-capture-draft.js";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function capture(provider: "spotify" | "soundcloud" | "youtube", resourceKind: string, url: string) {
  return {
    schemaVersion: 1,
    provider,
    resourceKind,
    canonicalUrl: url,
    redactedDisplayUrl: url,
    containsSecret: false,
    capturedAtMs: 1_800_000_000_000,
  } as const;
}

test("sequential public MV3 captures accumulate in one cross-tab draft and dedupe exact URLs", () => {
  const storage = new MemoryStorage();
  appendGuidedCapture(storage, capture("spotify", "playlist", "https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL"));
  appendGuidedCapture(storage, capture("spotify", "track", "https://open.spotify.com/track/0123456789ABCDEFGHIJKL"));
  appendGuidedCapture(storage, capture("spotify", "track", "https://open.spotify.com/track/ZYXWVUTSRQPONMLKJIHGFE"));
  appendGuidedCapture(storage, capture("spotify", "track", "https://open.spotify.com/track/0123456789ABCDEFGHIJKL"));

  const draft = readGuidedCaptureDraft(storage);
  assert.equal(draft.captures.length, 3);
  assert.deepEqual(draft.captures.map((entry) => entry.resourceKind), ["playlist", "track", "track"]);
  assert.equal(draft.captures.at(-1)?.canonicalUrl, "https://open.spotify.com/track/0123456789ABCDEFGHIJKL");
  assert.ok(storage.getItem(GUIDED_CAPTURE_DRAFT_KEY));
});

test("capture draft rejects secret and lookalike URLs rather than persisting them", () => {
  const storage = new MemoryStorage();
  assert.throws(() => appendGuidedCapture(storage, {
    ...capture("soundcloud", "track", "https://soundcloud.com/demo/track"),
    containsSecret: true,
  }), /PUBLIC_GUIDED_CAPTURE_REQUIRED/u);
  assert.throws(() => appendGuidedCapture(storage, capture("youtube", "video", "https://www.youtube.com.evil.test/watch?v=dQw4w9WgXcQ")), /PUBLIC_GUIDED_CAPTURE_REQUIRED/u);
  assert.equal(storage.getItem(GUIDED_CAPTURE_DRAFT_KEY), null);
});

test("legacy tab-scoped capture migrates once and draft entries can be consumed selectively", () => {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  session.setItem(LEGACY_GUIDED_CAPTURE_KEY, JSON.stringify(capture("youtube", "service-tab", "https://www.youtube.com/@demo")));
  const migrated = migrateLegacyGuidedCapture(session, local);
  assert.equal(session.getItem(LEGACY_GUIDED_CAPTURE_KEY), null);
  assert.equal(migrated.captures.length, 1);

  appendGuidedCapture(local, capture("youtube", "video", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
  const remaining = removeGuidedCaptures(local, (entry) => entry.resourceKind === "service-tab");
  assert.deepEqual(remaining.captures.map((entry) => entry.resourceKind), ["video"]);
  clearGuidedCaptureDraft(local);
  assert.equal(readGuidedCaptureDraft(local).captures.length, 0);
});
