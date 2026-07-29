import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { apiError, apiOk, requireUnlockedProfile } from "../_shared";
import { parseProviderUrl } from "../../../packages/connectors-core/src/url-policy";
import { requireCsrf, requireLocalRead } from "../../../packages/security/src/loopback-session";
import { getLocalDatabase } from "../../../packages/storage-local/src/database";

export const dynamic = "force-dynamic";

const trackSchema = z.object({
  title: z.string().trim().min(1).max(500),
  artist: z.string().trim().max(300).default(""),
  durationSeconds: z.number().finite().positive().max(86_400).optional(),
  url: z.string().url().max(2_048),
  unavailable: z.boolean().default(false),
});

const importSchema = z.object({
  provider: z.enum(["spotify", "soundcloud", "youtube"]),
  playlistUrl: z.string().url().max(2_048),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5_000).default(""),
  ownerLabel: z.string().trim().min(1).max(100),
  ownershipAttested: z.literal(true),
  editControlAttested: z.literal(true),
  expectedCount: z.number().int().nonnegative().max(100_000),
  tracks: z.array(trackSchema).max(10_000),
});

export function GET(request: Request) {
  try {
    requireLocalRead(request);
    requireUnlockedProfile();
    const provider = new URL(request.url).searchParams.get("provider") ?? undefined;
    return apiOk(getLocalDatabase().listPlaylistSnapshots(provider));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireCsrf(request);
    requireUnlockedProfile();
    const input = importSchema.parse(await request.json());
    const connection = getLocalDatabase().getConnection(input.provider);
    if (!connection || connection.status === "DISCONNECTED") throw new Error(`SERVICE_CONNECTION_REQUIRED:${input.provider}`);
    const playlistRef = parseProviderUrl(input.provider, input.playlistUrl);
    if (playlistRef.entityKind !== "playlist") throw new Error("PLAYLIST_URL_REQUIRED");
    if (playlistRef.containsSecretUrl) throw new Error("PRIVATE_URL_USE_ENCRYPTED_EXTENSION_HANDOFF");
    const tracks = input.tracks.map((track, position) => {
      const ref = parseProviderUrl(input.provider, track.url);
      if (ref.containsSecretUrl) throw new Error("PRIVATE_URL_USE_ENCRYPTED_EXTENSION_HANDOFF");
      const expectedKind = input.provider === "youtube" ? "video" : "track";
      if (ref.entityKind !== expectedKind) throw new Error("TRACK_URL_REQUIRED");
      if (input.provider === "youtube" && !ref.videoId) throw new Error("YOUTUBE_VIDEO_ID_REQUIRED");
      return {
        position,
        titleRaw: track.title,
        artistRaw: track.artist,
        durationMs: track.durationSeconds ? Math.round(track.durationSeconds * 1_000) : undefined,
        unavailable: track.unavailable,
        providerEntityId: ref.providerEntityId,
        videoId: ref.videoId,
        providerUriOrUrl: ref.providerUriOrUrl,
        attributionUrl: ref.redactedDisplayUrl,
        validationStatus: "USER_SELECTED_REAL_URL",
      };
    });
    const partial = input.expectedCount !== tracks.length;
    const snapshot = {
      provider: input.provider,
      playlistRef,
      title: input.title,
      description: input.description,
      ownerLabel: input.ownerLabel,
      expectedCount: input.expectedCount,
      tracks,
      partial,
      capturedAtMs: Date.now(),
    };
    const sourceVersion = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const id = getLocalDatabase().savePlaylistSnapshot({
      id: randomUUID(),
      provider: input.provider,
      providerPlaylistId: playlistRef.providerEntityId ?? playlistRef.playlistId,
      providerUrl: playlistRef.redactedDisplayUrl,
      title: input.title,
      description: input.description,
      ownerLabel: input.ownerLabel,
      eligibility: input.provider === "youtube" ? "EXPERIMENTAL_USER_ATTESTED_OWNED" : "USER_ATTESTED_OWNED",
      eligibilityEvidence: {
        method: "USER_ATTESTED_VISIBLE_OWNER_AND_EDIT_CONTROL",
        providerVerified: false,
        soundcloudBaseLegal: input.provider === "soundcloud" ? "unknown" : "not-applicable",
        arbitraryPublicUrlAccepted: false,
      },
      partial,
      sourceVersion,
      snapshot,
    });
    return apiOk({ id, partial, itemCount: tracks.length, sourceVersion }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
