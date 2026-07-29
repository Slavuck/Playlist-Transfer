export type MatchRiskMode = "SAFE" | "RISKY";
export type DedupePolicy = "NONE" | "TARGET_ID" | "CONFIRMED_EQUIVALENCE";
export type UnavailableItemPolicy = "CONTINUE_AND_REPORT" | "STOP_BEFORE_WRITE";
export type SoundcloudOverflowPolicy = "STOP" | "SPLIT_WITH_CONFIRMATION";
export type DestinationPrivacy = "PRIVATE" | "UNLISTED" | "PUBLIC" | "PROVIDER_DEFAULT";

export interface PerTransferMatchingSettings {
  readonly riskMode: MatchRiskMode;
  /** Human review is orthogonal to risk mode and is persisted with this transfer. */
  readonly reviewUncertain: boolean;
  readonly riskyRelevanceFallbackMinTitleSimilarity: number;
  readonly maxReviewCandidates: number;
}

export interface TransferSettings {
  readonly matching: PerTransferMatchingSettings;
  readonly preserveDuplicates: boolean;
  readonly preserveOrder: boolean;
  readonly dedupe: DedupePolicy;
  readonly unavailableItems: UnavailableItemPolicy;
  readonly destinationPrivacy: DestinationPrivacy;
  readonly privacyConfirmed: boolean;
  readonly copyCover: boolean;
  readonly coverRightsConfirmed: boolean;
  readonly soundcloudOverflow: SoundcloudOverflowPolicy;
}

export const DEFAULT_TRANSFER_SETTINGS: TransferSettings = Object.freeze({
  matching: Object.freeze({
    riskMode: "SAFE",
    reviewUncertain: true,
    riskyRelevanceFallbackMinTitleSimilarity: 0.72,
    maxReviewCandidates: 5,
  }),
  preserveDuplicates: true,
  preserveOrder: true,
  dedupe: "NONE",
  unavailableItems: "CONTINUE_AND_REPORT",
  destinationPrivacy: "PROVIDER_DEFAULT",
  privacyConfirmed: false,
  copyCover: false,
  coverRightsConfirmed: false,
  soundcloudOverflow: "STOP",
});

export type MatchingBehavior =
  | "SAFE_WITH_REVIEW"
  | "SAFE_SKIP_UNCERTAIN"
  | "RISKY_WITH_REVIEW"
  | "RISKY_AUTO_WITH_RELEVANCE_FALLBACK";

export function resolveMatchingBehavior(settings: PerTransferMatchingSettings): MatchingBehavior {
  if (settings.riskMode === "SAFE") {
    return settings.reviewUncertain ? "SAFE_WITH_REVIEW" : "SAFE_SKIP_UNCERTAIN";
  }
  return settings.reviewUncertain ? "RISKY_WITH_REVIEW" : "RISKY_AUTO_WITH_RELEVANCE_FALLBACK";
}

export function validateTransferSettings(settings: TransferSettings): TransferSettings {
  const similarity = settings.matching.riskyRelevanceFallbackMinTitleSimilarity;
  if (!Number.isFinite(similarity) || similarity < 0 || similarity > 1) {
    throw new RangeError("Risky relevance fallback title similarity must be between 0 and 1");
  }
  if (!Number.isInteger(settings.matching.maxReviewCandidates) || settings.matching.maxReviewCandidates < 3 || settings.matching.maxReviewCandidates > 5) {
    throw new RangeError("Review must show between 3 and 5 candidates");
  }
  if (settings.copyCover && !settings.coverRightsConfirmed) {
    throw new Error("Cover copying requires explicit rights confirmation");
  }
  if (settings.destinationPrivacy !== "PROVIDER_DEFAULT" && !settings.privacyConfirmed) {
    throw new Error("An explicit destination privacy choice requires confirmation");
  }
  return settings;
}

export function createTransferSettings(
  overrides: Partial<Omit<TransferSettings, "matching">> & {
    readonly matching?: Partial<PerTransferMatchingSettings>;
  } = {},
): TransferSettings {
  const settings: TransferSettings = {
    ...DEFAULT_TRANSFER_SETTINGS,
    ...overrides,
    matching: { ...DEFAULT_TRANSFER_SETTINGS.matching, ...overrides.matching },
  };
  return validateTransferSettings(settings);
}
