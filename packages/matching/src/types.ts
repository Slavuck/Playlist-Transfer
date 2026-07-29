import type {
  CandidateValidation,
  ProviderTrackReference,
} from "../../domain/src/index.js";

export const VERSION_MARKERS = [
  "LIVE",
  "REMIX",
  "EDIT",
  "REMASTER",
  "COVER",
  "SPED_UP",
  "SLOWED",
  "REVERB",
  "INSTRUMENTAL",
  "KARAOKE",
  "ACOUSTIC",
] as const;

export type VersionMarker = (typeof VERSION_MARKERS)[number];

export interface NormalizedText {
  readonly raw: string;
  readonly decoded: string;
  readonly normalized: string;
  readonly foldedDiacritics: string;
  readonly localeVariant?: string;
  readonly tokens: readonly string[];
}

export interface NormalizedTrackTitle extends NormalizedText {
  readonly core: string;
  readonly coreTokens: readonly string[];
  readonly versionMarkers: readonly VersionMarker[];
}

export type HypothesisKind =
  | "STRUCTURED"
  | "UPLOADER"
  | "PARSED_DASH"
  | "PARSED_TITLE_ARTIST"
  | "FEATURED_CONTRIBUTORS"
  | "TRANSLITERATION"
  | "VERSION_PRESERVING";

export interface TrackHypothesis {
  readonly kind: HypothesisKind;
  readonly titleRaw: string;
  readonly artistRaw?: string;
  readonly contributorsRaw: readonly string[];
  readonly title: NormalizedTrackTitle;
  readonly artist?: NormalizedText;
  readonly contributors: readonly NormalizedText[];
  readonly sourceFields: readonly string[];
}

export interface CandidateContextSignals {
  readonly structuredArtist?: boolean;
  readonly official?: boolean;
  readonly licensed?: boolean;
  readonly topic?: boolean;
  readonly duplicateAlias?: boolean;
}

export interface MatchCandidateInput {
  readonly target: ProviderTrackReference;
  readonly validation: CandidateValidation;
  readonly titleRaw?: string;
  readonly artistRaw?: string;
  readonly uploaderRaw?: string;
  readonly channelRaw?: string;
  readonly durationMs?: number;
  readonly isrc?: string;
  readonly embeddable?: boolean;
  readonly providerRank: number;
  readonly context?: CandidateContextSignals;
}

export type ScoreSignal = "TITLE" | "ARTIST" | "DURATION" | "VERSION" | "CONTEXT" | "PENALTY" | "ISRC";

export interface ScoreEvidence {
  readonly signal: ScoreSignal;
  readonly points: number;
  readonly detail: string;
}

export type MatchConflict =
  | "INVALID_TARGET_ID"
  | "UNAVAILABLE"
  | "TITLE_MISMATCH"
  | "ARTIST_MISMATCH"
  | "VERSION_MISMATCH"
  | "DURATION_OUTSIDE_REVIEW_WINDOW";

export interface ScoredCandidate {
  readonly candidate: MatchCandidateInput;
  readonly hypothesis: TrackHypothesis;
  readonly score: number;
  readonly deterministicConfirmed: boolean;
  readonly titleSimilarity: number;
  readonly artistSimilarity: number | null;
  readonly durationDeltaMs: number | null;
  readonly conflicts: readonly MatchConflict[];
  readonly hardConflicts: readonly MatchConflict[];
  readonly safeOnlyConflicts: readonly MatchConflict[];
  readonly evidence: readonly ScoreEvidence[];
}
