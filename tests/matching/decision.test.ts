import assert from "node:assert/strict";
import test from "node:test";
import { createTransferSettings } from "../../packages/domain/src/index.js";
import {
  buildTrackHypotheses,
  decideMatch,
  type MatchConflict,
  type ScoredCandidate,
} from "../../packages/matching/src/index.js";
import { providerValidation, youtubeTarget } from "../domain/fixtures.js";

function scored(
  id: string,
  score: number,
  options: {
    readonly rank?: number;
    readonly titleSimilarity?: number;
    readonly conflicts?: readonly MatchConflict[];
    readonly safeOnlyConflicts?: readonly MatchConflict[];
    readonly validation?: "provider" | "user";
    readonly deterministic?: boolean;
  } = {},
): ScoredCandidate {
  const target = youtubeTarget({
    providerEntityId: id, videoId: id,
    providerUriOrUrl: `https://www.youtube.com/watch?v=${id}`,
    redactedDisplayUrl: `https://www.youtube.com/watch?v=${id}`,
    attributionUrl: `https://www.youtube.com/watch?v=${id}`,
  });
  const conflicts = options.conflicts ?? [];
  return {
    candidate: {
      target,
      validation: options.validation === "user" ? { status: "USER_SELECTED_UNVERIFIED" } : providerValidation(target),
      providerRank: options.rank ?? 1,
    },
    hypothesis: buildTrackHypotheses({ titleRaw: "Song", artistRaw: "Artist" })[0]!,
    score,
    deterministicConfirmed: options.deterministic ?? false,
    titleSimilarity: options.titleSimilarity ?? 1,
    artistSimilarity: 1,
    durationDeltaMs: 0,
    conflicts,
    hardConflicts: conflicts.filter((item) => ["INVALID_TARGET_ID", "UNAVAILABLE", "TITLE_MISMATCH", "VERSION_MISMATCH"].includes(item)),
    safeOnlyConflicts: options.safeOnlyConflicts ?? [],
    evidence: [],
  };
}

const ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd", "eeeeeeeeeee", "fffffffffff"] as const;

test("safe high-auto requires score, provider validation, no conflicts and margin >= 8", () => {
  const settings = createTransferSettings().matching;
  assert.equal(decideMatch([scored(ids[0], 95), scored(ids[1], 86)], settings).kind, "HIGH_AUTO");
  assert.equal(decideMatch([scored(ids[0], 95), scored(ids[1], 90)], settings).kind, "REVIEW");
  assert.equal(decideMatch([scored(ids[0], 95, { validation: "user" }), scored(ids[1], 70)], settings).kind, "REVIEW");
  assert.equal(
    decideMatch([scored(ids[0], 95, { safeOnlyConflicts: ["ARTIST_MISMATCH"] }), scored(ids[1], 70)], settings).kind,
    "REVIEW",
  );
});

test("deterministic ISRC can overcome bad source text but not version/duration/provider conflicts", () => {
  const settings = createTransferSettings().matching;
  assert.equal(decideMatch([scored(ids[0], 100, { deterministic: true, conflicts: ["TITLE_MISMATCH"] })], settings).kind, "HIGH_AUTO");
  assert.equal(decideMatch([scored(ids[0], 100, { deterministic: true, conflicts: ["VERSION_MISMATCH"] })], settings).kind, "NOT_FOUND");
});

test("review displays only bounded, deduplicated candidates with persisted per-transfer behavior", () => {
  const settings = createTransferSettings({ matching: { maxReviewCandidates: 3 } }).matching;
  const decision = decideMatch(
    [scored(ids[0], 79), scored(ids[1], 78), scored(ids[2], 77), scored(ids[3], 76), scored(ids[0], 75)],
    settings,
  );
  assert.equal(decision.kind, "REVIEW");
  assert.equal(decision.reviewCandidates.length, 3);
  assert.deepEqual(decision.reviewCandidates.map((item) => item.score), [79, 78, 77]);
});

test("safe without review skips every uncertain candidate", () => {
  const settings = createTransferSettings({ matching: { reviewUncertain: false } }).matching;
  const decision = decideMatch([scored(ids[0], 91)], settings);
  assert.deepEqual([decision.kind, decision.riskBadge], ["NOT_FOUND", false]);
});

test("risky without review accepts normal 55+ candidate with a separate risk badge", () => {
  const settings = createTransferSettings({ matching: { riskMode: "RISKY", reviewUncertain: false } }).matching;
  const decision = decideMatch([scored(ids[0], 60)], settings);
  assert.deepEqual([decision.kind, decision.riskBadge, decision.selected?.candidate.target.videoId], ["RISKY_MATCH", true, ids[0]]);
});

test("risky relevance fallback uses official rank only after strong title overlap", () => {
  const settings = createTransferSettings({ matching: { riskMode: "RISKY", reviewUncertain: false } }).matching;
  const decision = decideMatch([
    scored(ids[0], 40, { rank: 2, titleSimilarity: 0.9 }),
    scored(ids[1], 35, { rank: 1, titleSimilarity: 0.8 }),
  ], settings);
  assert.deepEqual(
    [decision.kind, decision.selected?.candidate.target.videoId, decision.riskBadge],
    ["RISKY_RELEVANCE_FALLBACK", ids[1], true],
  );
});

test("risky mode never adds unrelated, version-conflicting, unavailable or user-unverified first result", () => {
  const settings = createTransferSettings({ matching: { riskMode: "RISKY", reviewUncertain: false } }).matching;
  assert.equal(decideMatch([scored(ids[0], 40, { titleSimilarity: 0.71 })], settings).kind, "NOT_FOUND");
  assert.equal(decideMatch([scored(ids[0], 70, { conflicts: ["VERSION_MISMATCH"] })], settings).kind, "NOT_FOUND");
  assert.equal(decideMatch([scored(ids[0], 70, { conflicts: ["UNAVAILABLE"] })], settings).kind, "NOT_FOUND");
  assert.equal(decideMatch([scored(ids[0], 70, { validation: "user" })], settings).kind, "NOT_FOUND");
});
