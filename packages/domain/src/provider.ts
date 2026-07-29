/** Provider-neutral contracts shared by the local UI, journal and adapters. */

export const PROVIDERS = ["spotify", "soundcloud", "youtube"] as const;

export type Provider = (typeof PROVIDERS)[number];
export type AdapterStrategy = "api" | "dom-read" | "ui-write" | "guided";
export type ProviderEntityKind = "track" | "video" | "playlist";

export interface ProviderCapabilities {
  readonly canReadOwned: boolean;
  readonly canReadCollaborative: boolean;
  readonly canWriteOwned: boolean;
  readonly canWriteCollaborative: boolean;
  readonly canCreate: boolean;
  readonly canBatchAdd: boolean;
  readonly batchSize: number | null;
  readonly canPreserveOrder: boolean;
  readonly canSetCoverOnCreate: boolean;
  readonly canSetCoverAfterCreate: boolean;
  readonly canSeekToFraction: boolean;
  readonly canEmbedAlongsideCompetitor: boolean;
  readonly maxPlaylistItems: number | null;
  readonly supportsISRC: boolean;
  readonly requiresWriteReauth: boolean;
}

export type ProviderAvailability =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "REGION_BLOCKED"
  | "DELETED"
  | "UNKNOWN";

/**
 * A real destination-side entity. `providerEntityId` is never a canonical-song
 * surrogate. YouTube references additionally carry the concrete videoId.
 */
export interface ProviderTrackReference {
  readonly provider: Provider;
  readonly entityKind: "track" | "video";
  readonly providerEntityId: string;
  readonly providerUriOrUrl: string;
  readonly containsSecretUrl: boolean;
  readonly redactedDisplayUrl: string;
  readonly videoId?: string;
  readonly titleRaw: string;
  readonly artistRaw?: string;
  readonly uploaderRaw?: string;
  readonly channelRaw?: string;
  readonly durationMs?: number;
  /** True only when an official provider response confirmed review embedding. */
  readonly embeddable?: boolean;
  readonly isrc?: string;
  readonly availability: ProviderAvailability;
  readonly attributionUrl: string;
  readonly fetchedAt: string;
}

export interface ProviderPlaylistReference {
  readonly provider: Provider;
  readonly providerPlaylistId: string;
  readonly providerUrl?: string;
  readonly title: string;
  readonly ownerId?: string;
}

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export function isSyntacticallyValidProviderEntityId(
  provider: Provider,
  id: string,
  kind: "track" | "video" = provider === "youtube" ? "video" : "track",
): boolean {
  const value = id.trim();
  if (!value) return false;

  if (provider === "youtube") {
    return kind === "video" && YOUTUBE_VIDEO_ID.test(value);
  }

  if (provider === "spotify") {
    return kind === "track" && /^[A-Za-z0-9]{22}$/.test(value);
  }

  return (
    kind === "track" &&
    (/^(?:urn:)?soundcloud:tracks:\d+$/.test(value) ||
      /^https:\/\/soundcloud\.com\/[^/?#]+\/[^/?#]+$/i.test(value))
  );
}

export function assertProviderTrackReference(
  reference: ProviderTrackReference,
): asserts reference is ProviderTrackReference {
  if (!isProvider(reference.provider)) {
    throw new TypeError("Unknown provider in track reference");
  }
  if (!reference.providerEntityId.trim()) {
    throw new TypeError("providerEntityId is required");
  }
  if (!reference.providerUriOrUrl.trim() || !reference.attributionUrl.trim()) {
    throw new TypeError("Provider URI/URL and attribution URL are required");
  }
  if (!reference.redactedDisplayUrl.trim()) {
    throw new TypeError("redactedDisplayUrl is required");
  }
  if (
    reference.containsSecretUrl &&
    (/secret_token=/i.test(reference.redactedDisplayUrl) || /secret_token=/i.test(reference.attributionUrl))
  ) {
    throw new TypeError("Secret URL tokens must be redacted from display and attribution URLs");
  }
  if (!reference.titleRaw.trim()) {
    throw new TypeError("titleRaw is required");
  }
  if (reference.durationMs !== undefined && (!Number.isFinite(reference.durationMs) || reference.durationMs < 0)) {
    throw new TypeError("durationMs must be a non-negative finite number");
  }
  if (Number.isNaN(Date.parse(reference.fetchedAt))) {
    throw new TypeError("fetchedAt must be an ISO-compatible timestamp");
  }

  if (reference.provider === "youtube") {
    if (reference.entityKind !== "video") {
      throw new TypeError("YouTube track references must be concrete video entities");
    }
    if (!reference.videoId || !YOUTUBE_VIDEO_ID.test(reference.videoId)) {
      throw new TypeError("A syntactically valid videoId is required for YouTube");
    }
    if (reference.providerEntityId !== reference.videoId) {
      throw new TypeError("YouTube providerEntityId must equal videoId");
    }
  } else {
    if (reference.entityKind !== "track") {
      throw new TypeError(`${reference.provider} references must use entityKind=track`);
    }
    if (reference.videoId !== undefined) {
      throw new TypeError("videoId is only valid for YouTube references");
    }
  }

  if (!isSyntacticallyValidProviderEntityId(reference.provider, reference.providerEntityId, reference.entityKind)) {
    throw new TypeError(`Invalid ${reference.provider} provider entity ID`);
  }
}

export function hasConcreteYoutubeVideoId(
  reference: ProviderTrackReference,
): reference is ProviderTrackReference & { readonly provider: "youtube"; readonly videoId: string } {
  return (
    reference.provider === "youtube" &&
    reference.entityKind === "video" &&
    typeof reference.videoId === "string" &&
    YOUTUBE_VIDEO_ID.test(reference.videoId) &&
    reference.providerEntityId === reference.videoId
  );
}
