import { assertCandidateValidation, type PerTransferMatchingSettings } from "../../domain/src/index.js";
import type { ScoredCandidate } from "./types.js";

export type MatchDecisionKind =
  | "HIGH_AUTO"
  | "REVIEW"
  | "RISKY_MATCH"
  | "RISKY_RELEVANCE_FALLBACK"
  | "NOT_FOUND";

export interface MatchDecision {
  readonly kind: MatchDecisionKind;
  readonly selected?: ScoredCandidate;
  readonly reviewCandidates: readonly ScoredCandidate[];
  readonly topScore: number | null;
  readonly margin: number | null;
  readonly riskBadge: boolean;
  readonly reason: string;
}

function uniqueTargets(candidates: readonly ScoredCandidate[]): ScoredCandidate[] {
  const byId = new Map<string, ScoredCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.candidate.target.provider}:${candidate.candidate.target.providerEntityId}`;
    const current = byId.get(key);
    if (!current || candidate.score > current.score) byId.set(key, candidate);
  }
  return [...byId.values()];
}

function scoreOrder(left: ScoredCandidate, right: ScoredCandidate): number {
  return right.score - left.score || left.candidate.providerRank - right.candidate.providerRank;
}

function isProviderValidated(candidate: ScoredCandidate): boolean {
  if (candidate.candidate.validation.status !== "PROVIDER_VALIDATED") return false;
  try {
    assertCandidateValidation(candidate.candidate.target, candidate.candidate.validation);
    return true;
  } catch {
    return false;
  }
}

function hasAnyAutoConflict(candidate: ScoredCandidate): boolean {
  return candidate.hardConflicts.length > 0 || candidate.safeOnlyConflicts.length > 0;
}

function hasRiskyHardConflict(candidate: ScoredCandidate): boolean {
  return candidate.hardConflicts.some((conflict) =>
    ["INVALID_TARGET_ID", "UNAVAILABLE", "TITLE_MISMATCH", "VERSION_MISMATCH"].includes(conflict),
  );
}

function findRelevanceFallback(
  candidates: readonly ScoredCandidate[],
  minTitleSimilarity: number,
): ScoredCandidate | undefined {
  return [...candidates]
    .filter(
      (candidate) =>
        isProviderValidated(candidate) &&
        candidate.titleSimilarity >= minTitleSimilarity &&
        !hasRiskyHardConflict(candidate),
    )
    .sort((left, right) => left.candidate.providerRank - right.candidate.providerRank)[0];
}

export function decideMatch(
  scoredCandidates: readonly ScoredCandidate[],
  settings: PerTransferMatchingSettings,
): MatchDecision {
  const candidates = uniqueTargets(scoredCandidates).sort(scoreOrder);
  if (candidates.length === 0) {
    return { kind: "NOT_FOUND", reviewCandidates: [], topScore: null, margin: null, riskBadge: false, reason: "No real target candidates" };
  }
  const top = candidates[0]!;
  const second = candidates[1];
  const margin = second ? top.score - second.score : Infinity;
  const displayedMargin = Number.isFinite(margin) ? Math.round(margin * 100) / 100 : null;
  const deterministicBlocker = top.conflicts.some((conflict) =>
    ["VERSION_MISMATCH", "DURATION_OUTSIDE_REVIEW_WINDOW", "UNAVAILABLE", "INVALID_TARGET_ID"].includes(conflict),
  );
  const high =
    isProviderValidated(top) &&
    ((top.deterministicConfirmed && !deterministicBlocker) ||
      (!top.deterministicConfirmed && top.score >= 92 && !hasAnyAutoConflict(top))) &&
    margin >= 8;
  if (high) {
    return { kind: "HIGH_AUTO", selected: top, reviewCandidates: [], topScore: top.score, margin: displayedMargin, riskBadge: false, reason: top.deterministicConfirmed ? "Deterministic confirmed match" : "High score with an adequate margin and no hard conflict" };
  }

  const ordinaryCandidates = candidates.filter(
    (candidate) => candidate.score >= 55 && !hasRiskyHardConflict(candidate),
  );
  const fallback = findRelevanceFallback(candidates, settings.riskyRelevanceFallbackMinTitleSimilarity);

  if (settings.reviewUncertain) {
    const reviewPool = [...ordinaryCandidates];
    if (settings.riskMode === "RISKY" && fallback && !reviewPool.includes(fallback)) reviewPool.push(fallback);
    const reviewCandidates = reviewPool.sort(scoreOrder).slice(0, settings.maxReviewCandidates);
    if (reviewCandidates.length > 0) {
      return {
        kind: "REVIEW",
        reviewCandidates,
        topScore: top.score,
        margin: displayedMargin,
        riskBadge: settings.riskMode === "RISKY" && reviewCandidates.some((candidate) => candidate.score < 80),
        reason: margin < 8 ? "Top candidates are too close" : "Candidate requires human review",
      };
    }
    return { kind: "NOT_FOUND", reviewCandidates: [], topScore: top.score, margin: displayedMargin, riskBadge: false, reason: "No candidate meets the review floor" };
  }

  if (settings.riskMode === "SAFE") {
    return { kind: "NOT_FOUND", reviewCandidates: [], topScore: top.score, margin: displayedMargin, riskBadge: false, reason: "Safe mode skips uncertain matches when review is disabled" };
  }

  const ordinaryRisky = ordinaryCandidates.find(isProviderValidated);
  if (ordinaryRisky) {
    return { kind: "RISKY_MATCH", selected: ordinaryRisky, reviewCandidates: [], topScore: top.score, margin: displayedMargin, riskBadge: true, reason: "Risky mode accepted a composite score of at least 55" };
  }
  if (fallback) {
    return {
      kind: "RISKY_RELEVANCE_FALLBACK",
      selected: fallback,
      reviewCandidates: [],
      topScore: top.score,
      margin: displayedMargin,
      riskBadge: true,
      reason: `Official relevance fallback with title similarity ${fallback.titleSimilarity.toFixed(3)}`,
    };
  }
  return { kind: "NOT_FOUND", reviewCandidates: [], topScore: top.score, margin: displayedMargin, riskBadge: false, reason: "Risky mode still rejects unrelated or version-conflicting results" };
}
