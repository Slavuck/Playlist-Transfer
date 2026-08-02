import assert from "node:assert/strict";
import test from "node:test";
import { GuidedConnector } from "../../packages/connectors-core/src/guided-connector";
import { policyGates, selectConnectorStrategy } from "../../packages/connectors-core/src/policy";
import { parseProviderUrl } from "../../packages/connectors-core/src/url-policy";

test("all six source/destination directions use one guided connector contract", () => {
  const providers = ["spotify", "soundcloud", "youtube"] as const;
  const directions = providers.flatMap((source) => providers.filter((destination) => destination !== source).map((destination) => `${source}->${destination}`));
  assert.equal(directions.length, 6);
  for (const provider of providers) assert.equal(new GuidedConnector(provider).strategy, "guided");
});

test("Spotify, YouTube and SoundCloud URL policies return real provider identifiers", () => {
  const spotify = parseProviderUrl("spotify", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc");
  assert.equal(spotify.providerEntityId, "4uLU6hMCjMI75M1A2tKUQC");
  assert.equal(spotify.providerUriOrUrl.includes("?"), false);

  const youtube = parseProviderUrl("youtube", "https://youtu.be/dQw4w9WgXcQ?t=43");
  assert.equal(youtube.videoId, "dQw4w9WgXcQ");
  assert.equal(youtube.entityKind, "video");

  const soundcloud = parseProviderUrl("soundcloud", "https://soundcloud.com/artist/track?secret_token=s-abc");
  assert.equal(soundcloud.containsSecretUrl, true);
  assert.equal(soundcloud.redactedDisplayUrl.includes("s-abc"), false);
});

test("lookalike provider hosts and malformed YouTube IDs fail closed", () => {
  assert.throws(() => parseProviderUrl("spotify", "https://open.spotify.com.evil.test/track/4uLU6hMCjMI75M1A2tKUQC"));
  assert.throws(() => parseProviderUrl("youtube", "https://youtube.com/watch?v=short"));
  assert.throws(() => parseProviderUrl("soundcloud", "https://soundcloud.com/search/sounds?q=x"));
});

test("paid APIs never become mandatory connector strategies", () => {
  assert.equal(selectConnectorStrategy({ provider: "spotify", apiConfigured: true, apiIsFreeForThisUser: false }), "api");
  assert.equal(selectConnectorStrategy({ provider: "spotify", apiConfigured: false, apiIsFreeForThisUser: true }), "guided");
  assert.equal(selectConnectorStrategy({ provider: "soundcloud", apiConfigured: true, apiIsFreeForThisUser: false }), "guided");
  assert.equal(selectConnectorStrategy({ provider: "youtube", apiConfigured: false, apiIsFreeForThisUser: true }), "guided");
  assert.equal(selectConnectorStrategy({ provider: "youtube", apiConfigured: true, apiIsFreeForThisUser: true }), "api");
});

test("policy defaults physically keep DOM/UI automation and competitive playback off", () => {
  assert.notEqual(policyGates.spotifyDomRead, "allowed");
  assert.notEqual(policyGates.spotifyUiWrite, "allowed");
  assert.notEqual(policyGates.soundcloudDomRead, "allowed");
  assert.notEqual(policyGates.soundcloudUiWrite, "allowed");
  assert.equal(policyGates.youtubeDomRead, "blocked");
  assert.equal(policyGates.youtubeUiWrite, "blocked");
  assert.equal(policyGates.soundcloudCompetitivePlayback, "blocked");
  assert.equal(policyGates.spotifyCompetitivePlayback, "blocked");
  assert.equal(policyGates.spotifyCrossProviderAutoMatching, "allowed");
  assert.equal(policyGates.youtubeCrossProviderAutoMatching, "blocked");
  assert.notEqual(policyGates.youtubeOwnedApi, "allowed");
});
