import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNavigationTarget,
  inspectProviderTab,
  parseProviderProfileUrl,
  parseProviderResource,
} from "../src/url-policy.js";

test("Spotify URLs are canonicalized without tracking data", () => {
  const parsed = parseProviderResource(
    "https://open.spotify.com/intl-de/track/0123456789ABCDEFGHIJKL?si=secret#fragment",
  );
  assert.deepEqual(parsed, {
    provider: "spotify",
    resourceKind: "track",
    providerEntityId: "0123456789ABCDEFGHIJKL",
    canonicalUrl: "https://open.spotify.com/track/0123456789ABCDEFGHIJKL",
    redactedDisplayUrl: "https://open.spotify.com/track/0123456789ABCDEFGHIJKL",
    containsSecret: false,
  });
});

test("YouTube watch/share URLs always produce the concrete videoId", () => {
  const watch = parseProviderResource(
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890abcdef&si=tracking",
  );
  assert.equal(watch.videoId, "dQw4w9WgXcQ");
  assert.equal(watch.playlistId, "PL1234567890abcdef");
  assert.equal(watch.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

  const short = parseProviderResource("https://youtu.be/dQw4w9WgXcQ?si=tracking");
  assert.equal(short.videoId, "dQw4w9WgXcQ");
  assert.equal(short.resourceKind, "video");
  assert.throws(
    () => parseProviderResource("https://www.youtube.com/watch?list=PL1234567890abcdef"),
    { code: "YOUTUBE_VIDEO_ID_REQUIRED" },
  );
});

test("private SoundCloud values are retained only in canonical secret URL and redacted for UI", () => {
  const parsed = parseProviderResource(
    "https://soundcloud.com/demo/sets/private-set/s-AbCdEf12?secret_token=s-more-secret&utm_source=x",
  );
  assert.equal(parsed.provider, "soundcloud");
  assert.equal(parsed.resourceKind, "playlist");
  assert.equal(parsed.containsSecret, true);
  assert.match(parsed.canonicalUrl, /s-AbCdEf12/u);
  assert.match(parsed.canonicalUrl, /secret_token/u);
  assert.doesNotMatch(parsed.redactedDisplayUrl, /AbCdEf12|more-secret/u);
  assert.match(parsed.redactedDisplayUrl, /REDACTED/u);
});

test("public SoundCloud tracking parameters are discarded", () => {
  const parsed = parseProviderResource(
    "https://soundcloud.com/demo/track-name?si=tracking&utm_campaign=test",
  );
  assert.equal(parsed.containsSecret, false);
  assert.equal(parsed.canonicalUrl, "https://soundcloud.com/demo/track-name");
});

test("lookalike origins, insecure schemes, credentials and malformed resources fail closed", () => {
  for (const url of [
    "https://www.youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://user:password@open.spotify.com/track/0123456789ABCDEFGHIJKL",
    "https://open.spotify.com/episode/0123456789ABCDEFGHIJKL",
    "javascript:alert(1)",
  ]) {
    assert.throws(() => parseProviderResource(url));
  }
});

test("an official provider page can be attested without pretending it is a resource", () => {
  const inspected = inspectProviderTab("https://www.youtube.com/feed/subscriptions");
  assert.equal(inspected.provider, "youtube");
  assert.equal(inspected.resource, null);
  assert.equal(inspected.officialOrigin, "https://www.youtube.com");
  assert.equal(inspected.serviceTabUrl, null);
});

test("service-tab attestation canonicalizes only public provider profile pages", () => {
  assert.deepEqual(parseProviderProfileUrl("https://open.spotify.com/intl-de/user/demo_user?si=tracking"), {
    provider: "spotify",
    canonicalUrl: "https://open.spotify.com/user/demo_user",
  });
  assert.deepEqual(parseProviderProfileUrl("https://music.youtube.com/@demo-channel?feature=shared"), {
    provider: "youtube",
    canonicalUrl: "https://www.youtube.com/@demo-channel",
  });
  assert.deepEqual(parseProviderProfileUrl("https://www.soundcloud.com/demo-user/"), {
    provider: "soundcloud",
    canonicalUrl: "https://soundcloud.com/demo-user",
  });
  for (const url of [
    "https://open.spotify.com/track/0123456789ABCDEFGHIJKL",
    "https://www.youtube.com/feed/subscriptions",
    "https://soundcloud.com/demo-user/track-name",
    "https://soundcloud.com/settings",
  ]) assert.throws(() => parseProviderProfileUrl(url), { code: "UNSUPPORTED_PROFILE_TAB" });
});

test("typed navigation constructs exact provider URLs and rejects arbitrary values", () => {
  assert.equal(
    buildNavigationTarget({ provider: "youtube", action: "search", query: "artist title" }),
    "https://www.youtube.com/results?search_query=artist+title",
  );
  assert.equal(
    buildNavigationTarget({
      provider: "spotify",
      action: "track",
      trackId: "0123456789ABCDEFGHIJKL",
    }),
    "https://open.spotify.com/track/0123456789ABCDEFGHIJKL",
  );
  assert.throws(() =>
    buildNavigationTarget({ provider: "youtube", action: "video", videoId: "invalid" }),
  );
  assert.throws(() =>
    buildNavigationTarget({ provider: "soundcloud", action: "permalink", url: "https://evil.test/x" }),
  );
  assert.throws(() =>
    buildNavigationTarget({ provider: "youtube", action: "search", query: "bad\nquery" }),
  );
});
