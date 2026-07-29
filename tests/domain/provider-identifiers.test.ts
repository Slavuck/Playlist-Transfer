import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProviderTrackReference,
  hasConcreteYoutubeVideoId,
  parseProviderTrackIdentifier,
  parseSoundcloudIdentifier,
  parseSpotifyIdentifier,
  parseSpotifyTrackId,
  parseYoutubePlaylistId,
  parseYoutubeVideoId,
} from "../../packages/domain/src/index.js";
import { youtubeTarget } from "./fixtures.js";

test("Spotify IDs parse from URI, localized URL and explicit raw track ID", () => {
  const id = "4uLU6hMCjMI75M1A2tKUQC";
  assert.equal(parseSpotifyTrackId(`spotify:track:${id}`), id);
  assert.equal(parseSpotifyTrackId(`https://open.spotify.com/intl-de/track/${id}?si=tracking`), id);
  assert.equal(parseSpotifyTrackId(id), id);
  assert.equal(parseSpotifyIdentifier(`spotify:playlist:${id}`, "track"), null);
  assert.equal(parseSpotifyTrackId("not-a-track"), null);
});

test("YouTube parser extracts only concrete 11-character video IDs", () => {
  const id = "dQw4w9WgXcQ";
  assert.equal(parseYoutubeVideoId(`https://www.youtube.com/watch?v=${id}&list=PL1234567890`), id);
  assert.equal(parseYoutubeVideoId(`https://music.youtube.com/watch?v=${id}`), id);
  assert.equal(parseYoutubeVideoId(`https://youtu.be/${id}?t=42`), id);
  assert.equal(parseYoutubeVideoId(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(parseYoutubeVideoId("https://evil.example/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(parseYoutubeVideoId("too-short"), null);
  assert.equal(parseYoutubePlaylistId("https://www.youtube.com/playlist?list=PL1234567890"), "PL1234567890");
  assert.equal(parseYoutubePlaylistId(id), null);
});

test("SoundCloud parser preserves provider URNs and redacts secret permalink tokens", () => {
  const urn = parseSoundcloudIdentifier("soundcloud:tracks:123456", "track");
  assert.equal(urn?.providerEntityId, "soundcloud:tracks:123456");

  const secret = parseSoundcloudIdentifier(
    "https://soundcloud.com/example/track-name?secret_token=s-very-secret&utm_source=x",
    "track",
  );
  assert.equal(secret?.containsSecretUrl, true);
  assert.equal(secret?.redactedDisplayUrl, "https://soundcloud.com/example/track-name");
  assert.match(secret?.canonicalUriOrUrl ?? "", /secret_token=/);
  assert.doesNotMatch(secret?.redactedDisplayUrl ?? "", /secret/i);

  assert.equal(parseSoundcloudIdentifier("https://soundcloud.com/example/sets/my-list", "playlist")?.entityKind, "playlist");
  assert.equal(parseSoundcloudIdentifier("https://soundcloud.com/discover", "track"), null);
});

test("generic provider parser dispatches without accepting cross-provider origins", () => {
  assert.equal(parseProviderTrackIdentifier("youtube", "https://youtu.be/dQw4w9WgXcQ")?.provider, "youtube");
  assert.equal(parseProviderTrackIdentifier("spotify", "https://youtu.be/dQw4w9WgXcQ"), null);
});

test("YouTube references fail closed when videoId is missing or differs from entity ID", () => {
  const valid = youtubeTarget();
  assert.doesNotThrow(() => assertProviderTrackReference(valid));
  assert.equal(hasConcreteYoutubeVideoId(valid), true);
  assert.throws(() => assertProviderTrackReference(youtubeTarget({ videoId: undefined })), /videoId/);
  assert.throws(() => assertProviderTrackReference(youtubeTarget({ videoId: "aaaaaaaaaaa" })), /must equal/);
  assert.throws(() => assertProviderTrackReference(youtubeTarget({ entityKind: "track" })), /video/);
});
