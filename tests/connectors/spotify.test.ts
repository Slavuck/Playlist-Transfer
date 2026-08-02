import assert from "node:assert/strict";
import test from "node:test";
import { SpotifyApiClient, type SpotifyPlaylist, type SpotifyTrack } from "../../packages/connectors/spotify/src/client";
import { SpotApiBridgeError, getSpotApiDiagnostic, type SpotApiBridge, type SpotApiCommand } from "../../packages/connectors/spotify/src/bridge";
import { parseSpotApiCookies } from "../../packages/connectors/spotify/src/cookies";

const playlistId = "P".repeat(22);
const trackId = "T".repeat(22);
const credentials = {
  identifier: "playlist-transfer-local",
  cookies: { sp_dc: "secret-session", sp_key: "optional-key" },
  connectedAtMs: Date.now(),
};

const playlist: SpotifyPlaylist = {
  id: playlistId,
  title: "Codex",
  description: "Transfer fixture",
  itemCount: 0,
  privacyStatus: "private",
  ownerId: "spotify-owner",
  ownerLabel: "Owner",
  snapshotId: "revision-1",
  url: `https://open.spotify.com/playlist/${playlistId}`,
  ownership: "API_OWNED",
};

function track(id = trackId, position = 0): SpotifyTrack {
  return {
    trackId: id,
    title: "Smells Like Teen Spirit",
    artist: "Nirvana",
    durationMs: 301_000,
    position,
    availability: "AVAILABLE",
    url: `https://open.spotify.com/track/${id}`,
  };
}

class FakeBridge implements SpotApiBridge {
  actualTrackIds: string[] = [];
  commands: SpotApiCommand[] = [];

  async run<T>(command: SpotApiCommand): Promise<T> {
    this.commands.push(command);
    if (command.operation !== "status") assert.equal(command.credentials?.cookies.sp_dc, "secret-session");
    switch (command.operation) {
      case "status":
        return { installed: true, package: "spotapi", version: "1.2.8", python: "3.11.9" } as T;
      case "account":
        return { accountId: "spotify-owner", userId: "spotify-owner", displayName: "Owner", profileUrl: "https://open.spotify.com/user/spotify-owner" } as T;
      case "playlists":
        return { playlists: [playlist] } as T;
      case "search_tracks":
      case "track":
        return (command.operation === "track" ? { track: track() } : { tracks: [track()] }) as T;
      case "playlist_snapshot":
      case "verify_playlist":
        return {
          playlist: { ...playlist, itemCount: this.actualTrackIds.length },
          tracks: this.actualTrackIds.map((id, index) => track(id, index)),
          sourceVersion: `revision-${this.actualTrackIds.length + 1}`,
        } as T;
      case "append_track":
        this.actualTrackIds.push(String(command.trackId));
        return { snapshotId: "spotapi:write" } as T;
      case "create_playlist":
        return { id: playlistId, url: playlist.url } as T;
      default:
        throw new Error(`Unexpected command: ${command.operation}`);
    }
  }
}

test("SpotAPI cookie parser keeps only required Spotify session cookies", () => {
  assert.deepEqual(
    parseSpotApiCookies("sp_dc=abc==; sp_key=key; unrelated=discard; sp_t=device"),
    { sp_dc: "abc==", sp_key: "key", sp_t: "device" },
  );
  assert.throws(() => parseSpotApiCookies("sp_key=missing-dc"), /SPOTAPI_SP_DC_REQUIRED/u);
  assert.throws(() => parseSpotApiCookies("sp_dc=value\r\ninjected=yes"), /SPOTAPI_COOKIE_HEADER_INVALID/u);
});

test("SpotAPI diagnostic reports the locally installed package", async () => {
  const diagnostic = await getSpotApiDiagnostic(new FakeBridge());
  assert.deepEqual(diagnostic, { installed: true, package: "spotapi", version: "1.2.8", python: "3.11.9" });
});

test("Spotify connector maps owned playlists and private-API search candidates", async () => {
  const bridge = new FakeBridge();
  const client = new SpotifyApiClient(credentials, { bridge });
  assert.equal((await client.getCurrentAccount()).displayName, "Owner");
  const playlists = await client.listEligiblePlaylists();
  assert.deepEqual(playlists.map((item) => item.title), ["Codex"]);
  assert.equal(playlists[0]?.ownership, "API_OWNED");
  const candidates = await client.searchCandidates("Nirvana Smells Like Teen Spirit");
  assert.equal(candidates[0]?.providerEntityId, trackId);
  assert.equal(candidates[0]?.validationStatus, "PROVIDER_VALIDATED");
  assert.equal(bridge.commands.at(-1)?.operation, "search_tracks");
});

test("SpotAPI append is observable through playlist read-after-write", async () => {
  const bridge = new FakeBridge();
  const client = new SpotifyApiClient(credentials, { bridge });
  assert.deepEqual((await client.verifyPlaylist(playlistId, [trackId])).actualTrackIds, []);
  assert.equal((await client.appendItem(playlistId, trackId)).snapshotId, "spotapi:write");
  const after = await client.verifyPlaylist(playlistId, [trackId]);
  assert.equal(after.verified, true);
  assert.deepEqual(after.actualTrackIds, [trackId]);
});

test("SpotAPI target validation records private-provider evidence honestly", async () => {
  const client = new SpotifyApiClient(credentials, { bridge: new FakeBridge() });
  const result = await client.validateTargetEntity({
    provider: "spotify",
    entityKind: "track",
    providerEntityId: trackId,
    providerUriOrUrl: `https://open.spotify.com/track/${trackId}`,
    containsSecretUrl: false,
    redactedDisplayUrl: `https://open.spotify.com/track/${trackId}`,
    validationStatus: "SYNTAX_CONFIRMED",
    attributionUrl: `https://open.spotify.com/track/${trackId}`,
  });
  assert.equal(result.evidence.method, "PROVIDER_PRIVATE_API");
  assert.equal(result.evidence.providerReadBack, true);
  assert.ok(result.limitations.includes("SPOTAPI_PRIVATE_API_UNOFFICIAL"));
});

test("SpotAPI append rejects malformed IDs before starting the bridge", async () => {
  const bridge = new FakeBridge();
  const client = new SpotifyApiClient(credentials, { bridge });
  await assert.rejects(() => client.appendItem(playlistId, "short"), /SPOTAPI_TRACK_ID_REQUIRED/u);
  assert.equal(bridge.commands.length, 0);
});

test("expired SpotAPI sessions mark the local connection for reauthentication", async () => {
  let marked = false;
  const bridge: SpotApiBridge = {
    run: async () => { throw new SpotApiBridgeError("SPOTAPI_SESSION_EXPIRED"); },
  };
  const client = new SpotifyApiClient(credentials, { bridge, onReauthRequired: () => { marked = true; } });
  await assert.rejects(() => client.getCurrentAccount(), /SPOTAPI_SESSION_EXPIRED/u);
  assert.equal(marked, true);
});
