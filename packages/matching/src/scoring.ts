import { isSyntacticallyValidProviderEntityId } from "../../domain/src/index.js";
import { compareDuration } from "./duration.js";
import { normalizeText, normalizeTrackTitle } from "./normalization.js";
import type {
  MatchCandidateInput,
  MatchConflict,
  ScoredCandidate,
  ScoreEvidence,
  TrackHypothesis,
  VersionMarker,
} from "./types.js";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function tokenF1(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) if (rightSet.has(token)) intersection += 1;
  const precision = intersection / rightSet.size;
  const recall = intersection / leftSet.size;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function bigrams(value: string): readonly string[] {
  const compact = value.replace(/\s+/g, " ");
  if (compact.length < 2) return compact ? [compact] : [];
  return Array.from({ length: compact.length - 1 }, (_, index) => compact.slice(index, index + 2));
}

function diceCoefficient(left: string, right: string): number {
  if (left === right) return left ? 1 : 0;
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (leftBigrams.length === 0 || rightBigrams.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const value of leftBigrams) counts.set(value, (counts.get(value) ?? 0) + 1);
  let intersection = 0;
  for (const value of rightBigrams) {
    const count = counts.get(value) ?? 0;
    if (count > 0) {
      intersection += 1;
      counts.set(value, count - 1);
    }
  }
  return (2 * intersection) / (leftBigrams.length + rightBigrams.length);
}

export function lexicalSimilarity(
  leftNormalized: string,
  rightNormalized: string,
  leftTokens: readonly string[],
  rightTokens: readonly string[],
): number {
  if (!leftNormalized || !rightNormalized) return 0;
  if (leftNormalized === rightNormalized) return 1;
  return clamp01(Math.max(tokenF1(leftTokens, rightTokens), diceCoefficient(leftNormalized, rightNormalized)));
}

function markerSetEqual(left: readonly VersionMarker[], right: readonly VersionMarker[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((marker) => rightSet.has(marker));
}

function pushConflict(target: MatchConflict[], conflict: MatchConflict): void {
  if (!target.includes(conflict)) target.push(conflict);
}

function sourceArtistTokens(hypothesis: TrackHypothesis): readonly string[] {
  return [
    ...(hypothesis.artist?.tokens ?? []),
    ...hypothesis.contributors.flatMap((contributor) => contributor.tokens),
  ];
}

export interface ScoreCandidateOptions {
  readonly locale?: string;
}

export function scoreCandidate(
  hypothesis: TrackHypothesis,
  candidate: MatchCandidateInput,
  options: ScoreCandidateOptions = {},
): ScoredCandidate {
  const locale = options.locale ?? "und";
  const candidateTitle = normalizeTrackTitle(candidate.titleRaw ?? candidate.target.titleRaw, locale);
  // Uploader/channel are context, never silently promoted to a structured artist.
  const candidateArtistRaw = candidate.artistRaw ?? candidate.target.artistRaw;
  const candidateArtist = candidateArtistRaw ? normalizeText(candidateArtistRaw, locale) : null;
  const titleSimilarity = lexicalSimilarity(
    hypothesis.title.core,
    candidateTitle.core,
    hypothesis.title.coreTokens,
    candidateTitle.coreTokens,
  );
  const hypothesisArtistTokens = sourceArtistTokens(hypothesis);
  const artistSimilarity =
    hypothesisArtistTokens.length > 0 && candidateArtist
      ? lexicalSimilarity(
          hypothesisArtistTokens.join(" "),
          candidateArtist.normalized,
          hypothesisArtistTokens,
          candidateArtist.tokens,
        )
      : null;

  const evidence: ScoreEvidence[] = [];
  const conflicts: MatchConflict[] = [];
  const hardConflicts: MatchConflict[] = [];
  const safeOnlyConflicts: MatchConflict[] = [];

  const validId = isSyntacticallyValidProviderEntityId(
    candidate.target.provider,
    candidate.target.providerEntityId,
    candidate.target.entityKind,
  );
  if (!validId || (candidate.target.provider === "youtube" && !candidate.target.videoId)) {
    pushConflict(conflicts, "INVALID_TARGET_ID");
    pushConflict(hardConflicts, "INVALID_TARGET_ID");
  }
  if (candidate.target.availability !== "AVAILABLE") {
    pushConflict(conflicts, "UNAVAILABLE");
    pushConflict(hardConflicts, "UNAVAILABLE");
  }

  let score = 0;
  const titlePoints = Math.round(titleSimilarity * 40 * 100) / 100;
  score += titlePoints;
  evidence.push({ signal: "TITLE", points: titlePoints, detail: titleSimilarity === 1 ? "Exact normalized title" : `Lexical title similarity ${titleSimilarity.toFixed(3)}` });
  if (titleSimilarity < 0.5) {
    score -= 25;
    evidence.push({ signal: "PENALTY", points: -25, detail: "Unrelated meaningful title tokens" });
    pushConflict(conflicts, "TITLE_MISMATCH");
    pushConflict(hardConflicts, "TITLE_MISMATCH");
  }

  if (artistSimilarity === null) {
    evidence.push({ signal: "ARTIST", points: 0, detail: "Artist signal unavailable; no credit" });
  } else {
    const artistPoints = Math.round(artistSimilarity * 30 * 100) / 100;
    score += artistPoints;
    evidence.push({ signal: "ARTIST", points: artistPoints, detail: artistSimilarity === 1 ? "Exact normalized artist" : `Artist token similarity ${artistSimilarity.toFixed(3)}` });
    if (artistSimilarity < 0.35) {
      score -= 20;
      evidence.push({ signal: "PENALTY", points: -20, detail: "Different primary artist" });
      pushConflict(conflicts, "ARTIST_MISMATCH");
      pushConflict(safeOnlyConflicts, "ARTIST_MISMATCH");
    }
  }

  const markersCompatible = markerSetEqual(hypothesis.title.versionMarkers, candidateTitle.versionMarkers);
  if (markersCompatible) {
    score += 10;
    evidence.push({ signal: "VERSION", points: 10, detail: "Version markers are compatible" });
  } else {
    score -= 25;
    evidence.push({ signal: "PENALTY", points: -25, detail: `Version mismatch: source [${hypothesis.title.versionMarkers.join(", ") || "base"}], target [${candidateTitle.versionMarkers.join(", ") || "base"}]` });
    pushConflict(conflicts, "VERSION_MISMATCH");
    pushConflict(hardConflicts, "VERSION_MISMATCH");
  }

  // A candidate adapter may pass an enriched duration differing from the thin target reference.
  const sourceDuration = (hypothesis as TrackHypothesis & { readonly durationMs?: number }).durationMs;
  const durationComparison = compareDuration(sourceDuration, candidate.durationMs ?? candidate.target.durationMs, false);
  let durationPoints = 0;
  if (durationComparison.band === "SAFE" && durationComparison.deltaMs !== null && durationComparison.safeWindowMs !== null) {
    durationPoints = 15 - 3 * (durationComparison.deltaMs / durationComparison.safeWindowMs);
  } else if (durationComparison.band === "REVIEW" && durationComparison.deltaMs !== null && durationComparison.safeWindowMs !== null && durationComparison.reviewWindowMs !== null) {
    const range = durationComparison.reviewWindowMs - durationComparison.safeWindowMs;
    durationPoints = range <= 0 ? 6 : 12 - 6 * ((durationComparison.deltaMs - durationComparison.safeWindowMs) / range);
  } else if (durationComparison.band === "OUTSIDE_REVIEW") {
    score -= 18;
    evidence.push({ signal: "PENALTY", points: -18, detail: "Duration is outside the review window" });
    pushConflict(conflicts, "DURATION_OUTSIDE_REVIEW_WINDOW");
    pushConflict(safeOnlyConflicts, "DURATION_OUTSIDE_REVIEW_WINDOW");
  }
  if (durationPoints > 0) {
    durationPoints = Math.round(durationPoints * 100) / 100;
    score += durationPoints;
    evidence.push({ signal: "DURATION", points: durationPoints, detail: `Duration delta ${durationComparison.deltaMs} ms` });
  } else if (durationComparison.band === "UNKNOWN") {
    evidence.push({ signal: "DURATION", points: 0, detail: "Duration unknown; no credit" });
  }

  const context = candidate.context ?? {};
  const candidateUploader = candidate.uploaderRaw ?? candidate.target.uploaderRaw ?? candidate.channelRaw ?? candidate.target.channelRaw;
  const uploaderContext =
    hypothesis.kind === "UPLOADER" && hypothesis.artist && candidateUploader
      ? lexicalSimilarity(
          hypothesis.artist.normalized,
          normalizeText(candidateUploader, locale).normalized,
          hypothesis.artist.tokens,
          normalizeText(candidateUploader, locale).tokens,
        )
      : 0;
  const contextPoints = Math.min(
    5,
    (context.structuredArtist ? 2 : 0) +
      (context.official ? 1 : 0) +
      (context.licensed ? 1 : 0) +
      (context.topic ? 1 : 0) +
      Math.round(uploaderContext * 2),
  );
  score += contextPoints;
  evidence.push({ signal: "CONTEXT", points: contextPoints, detail: "Provider context reliability (not popularity)" });
  if (candidate.embeddable === false) {
    score -= 2;
    evidence.push({ signal: "PENALTY", points: -2, detail: "Candidate cannot be embedded for review" });
  }
  if (context.duplicateAlias) {
    score -= 2;
    evidence.push({ signal: "PENALTY", points: -2, detail: "Duplicate candidate alias" });
  }

  return {
    candidate,
    hypothesis,
    score: Math.max(0, Math.min(100, Math.round(score * 100) / 100)),
    deterministicConfirmed: false,
    titleSimilarity,
    artistSimilarity,
    durationDeltaMs: durationComparison.deltaMs,
    conflicts,
    hardConflicts,
    safeOnlyConflicts,
    evidence,
  };
}

export interface SourceScoringInput {
  readonly hypothesis: TrackHypothesis;
  readonly durationMs?: number;
  readonly isrc?: string;
}

/** Scores against source duration/ISRC without mutating the persisted hypothesis. */
export function scoreCandidateForSource(
  source: SourceScoringInput,
  candidate: MatchCandidateInput,
  options: ScoreCandidateOptions = {},
): ScoredCandidate {
  const extended = { ...source.hypothesis, durationMs: source.durationMs } as TrackHypothesis;
  const scored = scoreCandidate(extended, candidate, options);
  const candidateIsrc = candidate.isrc ?? candidate.target.isrc;
  const isrcMatches = Boolean(source.isrc && candidateIsrc && source.isrc.trim().toUpperCase() === candidateIsrc.trim().toUpperCase());
  if (!isrcMatches || scored.conflicts.some((conflict) => ["VERSION_MISMATCH", "DURATION_OUTSIDE_REVIEW_WINDOW", "UNAVAILABLE", "INVALID_TARGET_ID"].includes(conflict))) {
    return scored;
  }
  return {
    ...scored,
    score: 100,
    deterministicConfirmed: true,
    evidence: [...scored.evidence, { signal: "ISRC", points: 100, detail: "Exact source/candidate ISRC with no version/duration conflict; deterministic confirmation" }],
  };
}
