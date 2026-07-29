import { z } from "zod";
import { apiError, apiOk, requireUnlockedProfile } from "../../_shared";
import { loadLocalYoutubeClient } from "../../../../packages/connectors/youtube/src/local";
import { requireCsrf, requireLocalRead } from "../../../../packages/security/src/loopback-session";
import { getLocalDatabase } from "../../../../packages/storage-local/src/database";
import type { YoutubeApiClient } from "../../../../packages/connectors/youtube/src/client";

export const dynamic = "force-dynamic";

const snapshotRequestSchema = z.union([
  z.object({ playlistId: z.string().min(10).max(128) }),
  z.object({
    action: z.literal("snapshot-many"),
    playlistIds: z.array(z.string().min(10).max(128)).min(1).max(100),
  }),
]);

async function saveYoutubeSnapshot(client: YoutubeApiClient, playlistId: string) {
  const snapshot = await client.getPlaylistSnapshot(playlistId);
  const database = getLocalDatabase();
  const rawExistingId = database.listPlaylistSnapshots("youtube")
    .find((item) => item.providerPlaylistId === snapshot.playlist.id)?.id;
  const existingId = typeof rawExistingId === "string" ? rawExistingId : undefined;
  const id = database.savePlaylistSnapshot({
    id: existingId,
    provider: "youtube",
    providerPlaylistId: snapshot.playlist.id,
    providerUrl: `https://www.youtube.com/playlist?list=${snapshot.playlist.id}`,
    title: snapshot.playlist.title,
    description: snapshot.playlist.description,
    ownerLabel: snapshot.playlist.channelTitle,
    eligibility: "API_VERIFIED_OWNED",
    eligibilityEvidence: {
      method: "YOUTUBE_PLAYLISTS_LIST_MINE_TRUE",
      channelId: snapshot.playlist.channelId,
      providerVerified: true,
    },
    partial: false,
    sourceVersion: snapshot.sourceVersion,
    snapshot: {
      provider: "youtube",
      playlist: snapshot.playlist,
      tracks: snapshot.tracks.map((track) => ({
        position: track.position,
        titleRaw: track.title,
        artistRaw: track.channelTitle,
        durationMs: track.durationMs,
        embeddable: track.embeddable === true,
        unavailable: track.availability !== "AVAILABLE",
        providerEntityId: track.videoId,
        videoId: track.videoId,
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
    const playlists = await loadLocalYoutubeClient().listEligiblePlaylists();
    return apiOk(playlists);
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
    const client = loadLocalYoutubeClient();
    const imported = [];
    for (const playlistId of playlistIds) imported.push(await saveYoutubeSnapshot(client, playlistId));
    return apiOk({ imported, count: imported.length }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
