import { z } from "zod";
import { apiError, apiOk, requireUnlockedProfile } from "../../_shared";
import { loadLocalSpotifyClient } from "../../../../packages/connectors/spotify/src/local";
import type { SpotifyApiClient } from "../../../../packages/connectors/spotify/src/client";
import { requireCsrf, requireLocalRead } from "../../../../packages/security/src/loopback-session";
import { getLocalDatabase } from "../../../../packages/storage-local/src/database";

export const dynamic = "force-dynamic";

const snapshotRequestSchema = z.union([
  z.object({ playlistId: z.string().regex(/^[A-Za-z0-9]{22}$/u) }),
  z.object({
    action: z.literal("snapshot-many"),
    playlistIds: z.array(z.string().regex(/^[A-Za-z0-9]{22}$/u)).min(1).max(100),
  }),
]);

async function saveSpotifySnapshot(client: SpotifyApiClient, playlistId: string) {
  const snapshot = await client.getPlaylistSnapshot(playlistId);
  const database = getLocalDatabase();
  const rawExistingId = database.listPlaylistSnapshots("spotify")
    .find((item) => item.providerPlaylistId === snapshot.playlist.id)?.id;
  const existingId = typeof rawExistingId === "string" ? rawExistingId : undefined;
  const id = database.savePlaylistSnapshot({
    id: existingId,
    provider: "spotify",
    providerPlaylistId: snapshot.playlist.id,
    providerUrl: snapshot.playlist.url,
    title: snapshot.playlist.title,
    description: snapshot.playlist.description,
    ownerLabel: snapshot.playlist.ownerLabel,
    eligibility: "API_VERIFIED_OWNED",
    eligibilityEvidence: {
      method: "SPOTIFY_ME_PLAYLISTS_OWNER_MATCH",
      accountId: snapshot.playlist.ownerId,
      providerVerified: true,
    },
    partial: false,
    sourceVersion: snapshot.sourceVersion,
    snapshot: {
      provider: "spotify",
      playlist: snapshot.playlist,
      tracks: snapshot.tracks.map((track) => ({
        position: track.position,
        titleRaw: track.title,
        artistRaw: track.artist,
        durationMs: track.durationMs,
        isrc: track.isrc,
        unavailable: track.availability !== "AVAILABLE",
        providerEntityId: track.trackId,
        providerUriOrUrl: track.url,
        attributionUrl: track.url,
        validationStatus: "PROVIDER_VALIDATED",
      })),
      capturedAtMs: Date.now(),
    },
  });
  return { id, playlist: snapshot.playlist, itemCount: snapshot.tracks.length };
}

export async function GET(request: Request) {
  try {
    requireLocalRead(request);
    requireUnlockedProfile();
    return apiOk(await loadLocalSpotifyClient().listEligiblePlaylists());
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireCsrf(request);
    requireUnlockedProfile();
    const input = snapshotRequestSchema.parse(await request.json());
    const playlistIds = "playlistId" in input ? [input.playlistId] : [...new Set(input.playlistIds)];
    const client = loadLocalSpotifyClient();
    const imported = [];
    for (const playlistId of playlistIds) imported.push(await saveSpotifySnapshot(client, playlistId));
    return apiOk({ imported, count: imported.length }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
