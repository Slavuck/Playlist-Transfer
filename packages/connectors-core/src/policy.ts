import type { ConnectorCapabilities, Provider } from "./types";

export type PolicyGateState = "allowed" | "blocked" | "unknown" | "not-applicable";

export const POLICY_VERSION = "2026-07-29";

export const policyGates = {
  spotifyGuidedTransfer: "allowed",
  spotifyOEmbedMetadata: "unknown",
  spotifyCrossProviderAutoMatching: "blocked",
  spotifyDomRead: "unknown",
  spotifyUiWrite: "unknown",
  spotifyCompetitivePlayback: "blocked",
  soundcloudBaseLegal: "unknown",
  soundcloudDomRead: "blocked",
  soundcloudUiWrite: "blocked",
  soundcloudCompetitivePlayback: "blocked",
  youtubeDomRead: "blocked",
  youtubeUiWrite: "blocked",
  youtubeOwnedApi: "unknown",
  youtubeOEmbedMetadata: "unknown",
  youtubeCrossProviderAutoMatching: "blocked",
  youtubeCollaborativeApi: "unknown",
} as const satisfies Record<string, PolicyGateState>;

export const PROVIDER_POLICY_ACKNOWLEDGEMENT = "I_ACCEPT_PROVIDER_POLICIES";

export function isYoutubeApiReleaseEnabled(): boolean {
  return process.env.PLAYLIST_TRANSFER_ENABLE_YOUTUBE_API === PROVIDER_POLICY_ACKNOWLEDGEMENT;
}

export function isProviderOEmbedEnabled(): boolean {
  return process.env.PLAYLIST_TRANSFER_ENABLE_PROVIDER_OEMBED === PROVIDER_POLICY_ACKNOWLEDGEMENT;
}

const baseGuided: ConnectorCapabilities = {
  canReadOwned: true,
  canReadCollaborative: false,
  canWriteOwned: true,
  canWriteCollaborative: false,
  canCreate: true,
  canBatchAdd: false,
  batchSize: 1,
  canPreserveOrder: true,
  canSetCoverOnCreate: "external-gate",
  canSetCoverAfterCreate: false,
  canSeekToFraction: false,
  canEmbedAlongsideCompetitor: false,
  supportsISRC: false,
  requiresWriteReauth: false,
  domRead: false,
  uiWrite: false,
};

export const guidedCapabilities: Record<Provider, ConnectorCapabilities> = {
  spotify: {
    ...baseGuided,
    canReadCollaborative: "unknown",
    canWriteCollaborative: "unknown",
  },
  soundcloud: {
    ...baseGuided,
    canReadOwned: "external-gate",
    canWriteOwned: "external-gate",
    canCreate: "external-gate",
    maxPlaylistItems: 500,
  },
  youtube: {
    ...baseGuided,
    canReadOwned: "unknown",
    canSeekToFraction: true,
    canSetCoverOnCreate: true,
  },
};

export const youtubeApiCapabilities: ConnectorCapabilities = {
  canReadOwned: true,
  canReadCollaborative: false,
  canWriteOwned: true,
  canWriteCollaborative: false,
  canCreate: true,
  canBatchAdd: false,
  batchSize: 1,
  canPreserveOrder: true,
  canSetCoverOnCreate: true,
  canSetCoverAfterCreate: true,
  canSeekToFraction: true,
  canEmbedAlongsideCompetitor: false,
  supportsISRC: false,
  requiresWriteReauth: true,
  domRead: false,
  uiWrite: false,
};

export const providerLimitations: Record<Provider, string[]> = {
  spotify: [
    "GUIDED_USER_ATTESTATION_NOT_PROVIDER_OWNERSHIP",
    "SPOTIFY_API_REQUIRES_NON_BASELINE_PREREQUISITES",
    "SPOTIFY_SEEK_NOT_AVAILABLE_IN_ZERO_BUDGET_BASELINE",
    "COMPETITIVE_PLAYBACK_EXTERNAL_GATE",
    "SPOTIFY_OEMBED_AND_METADATA_ANALYSIS_POLICY_GATE",
  ],
  soundcloud: [
    "SC_BASE_LEGAL_UNCONFIRMED",
    "SC_OEMBED_DOES_NOT_PROVIDE_STRUCTURED_DURATION_OR_URN",
    "SC_API_REQUIRES_ARTIST_PRO_AND_IS_NOT_BASELINE",
    "SC_CROSS_SERVICE_PLAYBACK_DISABLED",
  ],
  youtube: [
    "YOUTUBE_MUSIC_VISIBILITY_NOT_GUARANTEED",
    "YOUTUBE_COLLABORATIVE_MEMBERSHIP_NOT_API_VERIFIABLE",
    "YOUTUBE_DOM_AND_AUTOCLICK_FORBIDDEN",
    "YOUTUBE_MANUAL_OWNERSHIP_NOT_BASELINE_VERIFIED",
    "YOUTUBE_API_REQUIRES_OPERATOR_POLICY_ACKNOWLEDGEMENT",
    "YOUTUBE_CROSS_PROVIDER_AUTO_MATCHING_DISABLED",
  ],
};

export function isCapabilityEnabled(value: ConnectorCapabilities[keyof ConnectorCapabilities]): boolean {
  return value === true;
}

export function selectConnectorStrategy(input: {
  provider: Provider;
  apiConfigured: boolean;
  apiIsFreeForThisUser: boolean;
}): "api" | "guided" {
  if (input.provider === "youtube" && input.apiConfigured && input.apiIsFreeForThisUser) return "api";
  return "guided";
}
