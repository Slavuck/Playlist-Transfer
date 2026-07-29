import { createTransferSettings, type PerTransferMatchingSettings } from "../domain/src/index.js";
import {
  buildTrackHypotheses,
  decideMatch,
  scoreCandidateForSource,
  type ScoredCandidate,
} from "../matching/src/index.js";
import type { GoldCase } from "./gold-dataset.js";

export interface GoldQualityMetrics {
  readonly caseCount: number;
  readonly positiveCaseCount: number;
  readonly hardCaseCount: number;
  readonly hardCaseShare: number;
  readonly safeAutoSelectedCount: number;
  readonly safeTruePositiveCount: number;
  readonly safeFalsePositiveCount: number;
  readonly safePrecision: number;
  readonly safeFalsePositiveRate: number;
  readonly top5HitCount: number;
  readonly top5Recall: number;
}

export function scoreGoldCase(goldCase: GoldCase): readonly ScoredCandidate[] {
  const hypotheses = buildTrackHypotheses({
    titleRaw: goldCase.source.titleRaw,
    artistRaw: goldCase.source.artistRaw,
  });
  return goldCase.candidates.flatMap((candidate) =>
    hypotheses.map((hypothesis) => scoreCandidateForSource({
      hypothesis,
      durationMs: goldCase.source.durationMs,
      isrc: goldCase.source.isrc,
    }, candidate)),
  );
}

function bestUniqueTargets(scored: readonly ScoredCandidate[]): readonly ScoredCandidate[] {
  const unique = new Map<string, ScoredCandidate>();
  for (const item of scored) {
    const id = item.candidate.target.providerEntityId;
    const current = unique.get(id);
    if (!current || item.score > current.score) unique.set(id, item);
  }
  return [...unique.values()].sort(
    (left, right) => right.score - left.score || left.candidate.providerRank - right.candidate.providerRank,
  );
}

export function evaluateGoldDataset(
  cases: readonly GoldCase[],
  matching: PerTransferMatchingSettings = createTransferSettings({
    matching: { riskMode: "SAFE", reviewUncertain: true },
  }).matching,
): GoldQualityMetrics {
  let positives = 0;
  let hard = 0;
  let selected = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let top5Hits = 0;

  for (const goldCase of cases) {
    if (goldCase.difficulty === "HARD") hard += 1;
    const scored = scoreGoldCase(goldCase);
    const decision = decideMatch(scored, matching);
    if (goldCase.expectedTargetId !== null) {
      positives += 1;
      if (bestUniqueTargets(scored).slice(0, 5).some(
        (candidate) => candidate.candidate.target.providerEntityId === goldCase.expectedTargetId,
      )) top5Hits += 1;
    }
    if (decision.kind === "HIGH_AUTO") {
      selected += 1;
      if (decision.selected?.candidate.target.providerEntityId === goldCase.expectedTargetId) truePositives += 1;
      else falsePositives += 1;
    }
  }

  return {
    caseCount: cases.length,
    positiveCaseCount: positives,
    hardCaseCount: hard,
    hardCaseShare: cases.length === 0 ? 0 : hard / cases.length,
    safeAutoSelectedCount: selected,
    safeTruePositiveCount: truePositives,
    safeFalsePositiveCount: falsePositives,
    safePrecision: selected === 0 ? 1 : truePositives / selected,
    safeFalsePositiveRate: selected === 0 ? 0 : falsePositives / selected,
    top5HitCount: top5Hits,
    top5Recall: positives === 0 ? 1 : top5Hits / positives,
  };
}
