import assert from "node:assert/strict";
import test from "node:test";
import { openValue, sealValue } from "../../packages/hosted/src/crypto";
import { buildHostedSearchQuery } from "../../packages/hosted/src/server";
import { HostedSpotifyClient } from "../../packages/hosted/src/spotify";
import { parseYoutubeDuration } from "../../packages/hosted/src/youtube";

const SECRET = "hosted-test-secret-with-at-least-24-characters";
const PLAYLIST_ID = "ABCDEFGHIJKLMNOPQRSTUV";
const TRACK_ID = "ZYXWVUTSRQPONMLKJIHGFE";

test("hosted cookie envelope is authenticated and rejects tampering", () => {
  const value = { accessToken: "not-exposed", expiresAtMs: 123 };
  const sealed = sealValue(value, SECRET);
  assert.deepEqual(openValue(sealed, SECRET), value);
  assert.equal(openValue(`${sealed.slice(0, -1)}A`, SECRET), null);
  assert.equal(openValue(sealed, `${SECRET}-wrong`), null);
  assert.doesNotMatch(sealed, /not-exposed/u);
});

test("hosted search query cleans YouTube presentation text", () => {
  const query = buildHostedSearchQuery("youtube", {
    id: "abcdefghijk",
    title: "Nirvana - Come As You Are (Official Music Video)",
    artist: "NirvanaVEVO",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
    position: 0,
    available: true,
  });
  assert.equal(query, "track:\"Come As You Are\" artist:\"Nirvana\"");
});

test("Spotify hosted client uses the February 2026 playlist items endpoints", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/me")) return Response.json({ id: "user-name", display_name: "Tester" });
    if (url.endsWith(`/playlists/${PLAYLIST_ID}`)) return Response.json({
      id: PLAYLIST_ID,
      name: "Codex",
      snapshot_id: "snapshot-1",
      owner: { id: "user-name", display_name: "Tester" },
      external_urls: { spotify: `https://open.spotify.com/playlist/${PLAYLIST_ID}` },
    });
    if (url.includes(`/playlists/${PLAYLIST_ID}/items?limit=50`)) return Response.json({
      items: [{ item: {
        id: TRACK_ID,
        name: "Test song",
        artists: [{ name: "Test artist" }],
        duration_ms: 123_000,
        external_urls: { spotify: `https://open.spotify.com/track/${TRACK_ID}` },
      } }],
      next: null,
    });
    if (url.endsWith("/me/playlists")) return Response.json({ id: PLAYLIST_ID, external_urls: { spotify: "https://example.test/playlist" } });
    if (url.endsWith(`/playlists/${PLAYLIST_ID}/items`) && init?.method === "POST") return Response.json({ snapshot_id: "snapshot-2" });
    return Response.json({ error: { reason: "unexpected" } }, { status: 500 });
  };

  const client = new HostedSpotifyClient("token", fetchImpl);
  const snapshot = await client.snapshot(PLAYLIST_ID);
  assert.equal(snapshot.tracks[0]?.id, TRACK_ID);
  assert.equal(snapshot.playlist.writable, true);
  await client.createPlaylist({ title: "Codex 2", description: "test", public: false });
  await client.append(PLAYLIST_ID, [TRACK_ID]);
  assert.ok(calls.some((call) => call.url.endsWith("/me/playlists") && call.init?.method === "POST"));
  assert.ok(calls.some((call) => call.url.endsWith(`/playlists/${PLAYLIST_ID}/items`) && call.init?.method === "POST"));
  assert.ok(calls.every((call) => !call.url.includes(`/playlists/${PLAYLIST_ID}/tracks`)));
});

test("YouTube ISO-8601 durations are converted to milliseconds", () => {
  assert.equal(parseYoutubeDuration("PT3M42S"), 222_000);
  assert.equal(parseYoutubeDuration("PT1H2M3.5S"), 3_723_500);
  assert.equal(parseYoutubeDuration("not-a-duration"), undefined);
});
