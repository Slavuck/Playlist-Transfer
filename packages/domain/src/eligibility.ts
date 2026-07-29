import type { Provider } from "./provider.js";

export type PlaylistUse = "SOURCE" | "DESTINATION";
export type PlaylistEligibilityStatus =
  | "PROVIDER_VERIFIED_OWNED"
  | "PROVIDER_VERIFIED_COLLABORATIVE"
  | "USER_ATTESTED_OWNED"
  | "UNVERIFIED_NON_OWNED"
  | "WRITE_CONFIRMED_NON_OWNED"
  | "INELIGIBLE";

export type EligibilityReason =
  | "OWNED_BY_CURRENT_ACCOUNT"
  | "VERIFIED_COLLABORATIVE_CAPABILITY"
  | "USER_CONFIRMED_OWNER_AND_MANAGE_CONTROL"
  | "EXPERIMENTAL_NON_OWNED_NOT_PROVIDER_VERIFIED"
  | "EXPERIMENTAL_WRITE_SUCCEEDED_WITHOUT_MEMBERSHIP_PROOF"
  | "OWNER_MISMATCH"
  | "FOLLOWED_OR_PUBLIC_ONLY"
  | "COLLABORATION_NOT_SUPPORTED"
  | "CONTENT_NOT_READABLE"
  | "WRITE_CAPABILITY_NOT_VERIFIED"
  | "NOT_RETURNED_BY_PROVIDER_ACCOUNT_LIST"
  | "USER_ATTESTATION_INCOMPLETE"
  | "EXPERIMENTAL_MODE_DISABLED";

export interface PlaylistEligibilityDecision {
  readonly provider: Provider;
  readonly use: PlaylistUse;
  readonly eligible: boolean;
  readonly status: PlaylistEligibilityStatus;
  readonly reason: EligibilityReason;
  readonly independentlyVerified: boolean;
  readonly experimental: boolean;
}

export interface SpotifyEligibilityInput {
  readonly provider: "spotify";
  readonly use: PlaylistUse;
  readonly ownerAccountId?: string;
  readonly currentAccountId: string;
  readonly collaborative: boolean;
  readonly returnedForCurrentUser: boolean;
  readonly contentReadable: boolean;
  /** Must be freshly checked before append to an existing destination. */
  readonly modifyCapabilityVerified: boolean;
  readonly followedOrPublicOnly?: boolean;
}

export interface YoutubeEligibilityInput {
  readonly provider: "youtube";
  readonly use: PlaylistUse;
  readonly listedByMine: boolean;
  readonly manuallySuppliedNonOwned?: boolean;
  readonly allowExperimentalNonOwned?: boolean;
  readonly experimentalWriteSucceeded?: boolean;
}

export interface SoundcloudEligibilityInput {
  readonly provider: "soundcloud";
  readonly use: PlaylistUse;
  readonly strategy: "api" | "guided";
  readonly playlistOwnerUrn?: string;
  readonly currentUserUrn?: string;
  readonly returnedFromMePlaylists?: boolean;
  readonly likedRepostedOrFollowed?: boolean;
  readonly userConfirmedOwnerProfile?: boolean;
  readonly userConfirmedManageControl?: boolean;
}

export type PlaylistEligibilityInput =
  | SpotifyEligibilityInput
  | YoutubeEligibilityInput
  | SoundcloudEligibilityInput;

function decision(
  provider: Provider,
  use: PlaylistUse,
  eligible: boolean,
  status: PlaylistEligibilityStatus,
  reason: EligibilityReason,
  independentlyVerified: boolean,
  experimental = false,
): PlaylistEligibilityDecision {
  return { provider, use, eligible, status, reason, independentlyVerified, experimental };
}

function evaluateSpotify(input: SpotifyEligibilityInput): PlaylistEligibilityDecision {
  if (input.followedOrPublicOnly) {
    return decision("spotify", input.use, false, "INELIGIBLE", "FOLLOWED_OR_PUBLIC_ONLY", false);
  }
  if (!input.returnedForCurrentUser) {
    return decision("spotify", input.use, false, "INELIGIBLE", "NOT_RETURNED_BY_PROVIDER_ACCOUNT_LIST", false);
  }

  const owned = Boolean(input.ownerAccountId) && input.ownerAccountId === input.currentAccountId;
  if (owned) {
    if (input.use === "DESTINATION" && !input.modifyCapabilityVerified) {
      return decision("spotify", input.use, false, "INELIGIBLE", "WRITE_CAPABILITY_NOT_VERIFIED", false);
    }
    if (!input.contentReadable && input.use === "SOURCE") {
      return decision("spotify", input.use, false, "INELIGIBLE", "CONTENT_NOT_READABLE", false);
    }
    return decision("spotify", input.use, true, "PROVIDER_VERIFIED_OWNED", "OWNED_BY_CURRENT_ACCOUNT", true);
  }

  if (!input.collaborative) {
    return decision("spotify", input.use, false, "INELIGIBLE", "OWNER_MISMATCH", false);
  }
  if (!input.contentReadable) {
    return decision("spotify", input.use, false, "INELIGIBLE", "CONTENT_NOT_READABLE", false);
  }
  if (input.use === "DESTINATION" && !input.modifyCapabilityVerified) {
    return decision("spotify", input.use, false, "INELIGIBLE", "WRITE_CAPABILITY_NOT_VERIFIED", false);
  }
  return decision(
    "spotify",
    input.use,
    true,
    "PROVIDER_VERIFIED_COLLABORATIVE",
    "VERIFIED_COLLABORATIVE_CAPABILITY",
    true,
  );
}

function evaluateYoutube(input: YoutubeEligibilityInput): PlaylistEligibilityDecision {
  if (input.listedByMine) {
    return decision("youtube", input.use, true, "PROVIDER_VERIFIED_OWNED", "OWNED_BY_CURRENT_ACCOUNT", true);
  }
  if (!input.manuallySuppliedNonOwned) {
    return decision("youtube", input.use, false, "INELIGIBLE", "NOT_RETURNED_BY_PROVIDER_ACCOUNT_LIST", false);
  }
  if (!input.allowExperimentalNonOwned) {
    return decision("youtube", input.use, false, "INELIGIBLE", "EXPERIMENTAL_MODE_DISABLED", false);
  }

  if (input.experimentalWriteSucceeded) {
    return decision(
      "youtube",
      input.use,
      true,
      "WRITE_CONFIRMED_NON_OWNED",
      "EXPERIMENTAL_WRITE_SUCCEEDED_WITHOUT_MEMBERSHIP_PROOF",
      false,
      true,
    );
  }
  return decision(
    "youtube",
    input.use,
    input.use === "DESTINATION",
    "UNVERIFIED_NON_OWNED",
    "EXPERIMENTAL_NON_OWNED_NOT_PROVIDER_VERIFIED",
    false,
    true,
  );
}

function evaluateSoundcloud(input: SoundcloudEligibilityInput): PlaylistEligibilityDecision {
  if (input.likedRepostedOrFollowed) {
    return decision("soundcloud", input.use, false, "INELIGIBLE", "FOLLOWED_OR_PUBLIC_ONLY", false);
  }
  if (input.strategy === "api") {
    const ownerMatches =
      Boolean(input.playlistOwnerUrn) &&
      Boolean(input.currentUserUrn) &&
      input.playlistOwnerUrn === input.currentUserUrn;
    if (!input.returnedFromMePlaylists) {
      return decision("soundcloud", input.use, false, "INELIGIBLE", "NOT_RETURNED_BY_PROVIDER_ACCOUNT_LIST", false);
    }
    if (!ownerMatches) {
      return decision("soundcloud", input.use, false, "INELIGIBLE", "OWNER_MISMATCH", false);
    }
    return decision("soundcloud", input.use, true, "PROVIDER_VERIFIED_OWNED", "OWNED_BY_CURRENT_ACCOUNT", true);
  }

  if (!input.userConfirmedOwnerProfile || !input.userConfirmedManageControl) {
    return decision("soundcloud", input.use, false, "INELIGIBLE", "USER_ATTESTATION_INCOMPLETE", false);
  }
  return decision(
    "soundcloud",
    input.use,
    true,
    "USER_ATTESTED_OWNED",
    "USER_CONFIRMED_OWNER_AND_MANAGE_CONTROL",
    false,
  );
}

export function evaluatePlaylistEligibility(input: PlaylistEligibilityInput): PlaylistEligibilityDecision {
  if (input.provider === "spotify") return evaluateSpotify(input);
  if (input.provider === "youtube") return evaluateYoutube(input);
  return evaluateSoundcloud(input);
}

export function assertEligiblePlaylist(
  result: PlaylistEligibilityDecision,
): asserts result is PlaylistEligibilityDecision & { readonly eligible: true } {
  if (!result.eligible || result.status === "INELIGIBLE") {
    throw new Error(`Playlist is not eligible: ${result.reason}`);
  }
}
