import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTrackHypotheses,
  compareDuration,
  durationWindows,
  lexicalSimilarity,
  scoreCandidateForSource,
  type MatchCandidateInput,
} from "../../packages/matching/src/index.js";
import { providerValidation, youtubeTarget } from "../domain/fixtures.js";

test("duration windows use max(4s, 3%) and max(12s, 10%)", () => {
  assert.deepEqual(durationWindows(100_000), { safeMs: 4_000, reviewMs: 12_000 });
  assert.deepEqual(durationWindows(300_000), { safeMs: 9_000, reviewMs: 30_000 });
  assert.equal(compareDuration(200_000, 203_000).band, "SAFE");
  assert.equal(compareDuration(200_000, 215_000).band, "REVIEW");
  assert.equal(compareDuration(200_000, 230_000).band, "OUTSIDE_REVIEW");
  assert.equal(compareDuration(200_000, 230_000, true).band, "VERSION_EXPLAINED");
  assert.equal(compareDuration(undefined, 200_000).band, "UNKNOWN");
});

test("lexical similarity rewards exact/token overlap without treating rank as evidence", () => {
  assert.equal(lexicalSimilarity("massive attack", "massive attack", ["massive", "attack"], ["massive", "attack"]), 1);
  assert.ok(lexicalSimilarity("never gonna give you up", "never gonna give u up", ["never", "gonna", "give", "you", "up"], ["never", "gonna", "give", "u", "up"]) > 0.7);
  assert.equal(lexicalSimilarity("one", "completely different", ["one"], ["completely", "different"]), 0);
});

function candidate(overrides: Partial<MatchCandidateInput> = {}): MatchCandidateInput {
  const target = youtubeTarget();
  return {
    target,
    validation: providerValidation(target),
    titleRaw: target.titleRaw,
    artistRaw: "Rick Astley",
    durationMs: target.durationMs,
    isrc: "GBARL9300135",
    embeddable: true,
    providerRank: 1,
    context: { structuredArtist: true, official: true, licensed: true, topic: true },
    ...overrides,
  };
}

test("explainable score reaches high confidence only with compatible title/artist/version/duration", () => {
  const hypothesis = buildTrackHypotheses({ titleRaw: "Never Gonna Give You Up", artistRaw: "Rick Astley" })[0]!;
  const scored = scoreCandidateForSource(
    { hypothesis, durationMs: 213_000 },
    candidate({ isrc: undefined }),
  );
  assert.equal(scored.score, 100);
  assert.deepEqual(scored.conflicts, []);
  assert.equal(scored.deterministicConfirmed, false);
  assert.deepEqual(scored.evidence.filter((item) => item.points > 0).map((item) => item.signal), ["TITLE", "ARTIST", "VERSION", "DURATION", "CONTEXT"]);
});

test("exact source/candidate ISRC is deterministic unless version or duration conflicts", () => {
  const hypothesis = buildTrackHypotheses({ titleRaw: "Source metadata typo", artistRaw: "Wrong field" })[0]!;
  const exactIsrc = scoreCandidateForSource(
    { hypothesis, durationMs: 213_000, isrc: "GBARL9300135" },
    candidate(),
  );
  assert.equal(exactIsrc.deterministicConfirmed, true);
  assert.equal(exactIsrc.score, 100);

  const live = candidate({ titleRaw: "Never Gonna Give You Up (Live)", durationMs: 260_000 });
  const blocked = scoreCandidateForSource(
    { hypothesis: buildTrackHypotheses({ titleRaw: "Never Gonna Give You Up", artistRaw: "Rick Astley" })[0]!, durationMs: 213_000, isrc: "GBARL9300135" },
    live,
  );
  assert.equal(blocked.deterministicConfirmed, false);
  assert.ok(blocked.conflicts.includes("VERSION_MISMATCH"));
  assert.ok(blocked.conflicts.includes("DURATION_OUTSIDE_REVIEW_WINDOW"));
});

test("unknown duration grants no points and large duration difference remains a visible safe conflict", () => {
  const hypothesis = buildTrackHypotheses({ titleRaw: "Never Gonna Give You Up", artistRaw: "Rick Astley" })[0]!;
  const unknown = scoreCandidateForSource({ hypothesis }, candidate({ durationMs: undefined, target: youtubeTarget({ durationMs: undefined }), isrc: undefined }));
  assert.equal(unknown.durationDeltaMs, null);
  assert.ok(unknown.evidence.some((item) => item.signal === "DURATION" && item.points === 0));

  const long = scoreCandidateForSource({ hypothesis, durationMs: 213_000 }, candidate({ durationMs: 300_000, isrc: undefined }));
  assert.ok(long.safeOnlyConflicts.includes("DURATION_OUTSIDE_REVIEW_WINDOW"));
  assert.ok(long.evidence.some((item) => item.points === -18));
});

test("uploader/channel identity is context and never silently receives artist points", () => {
  const hypothesis = buildTrackHypotheses({ titleRaw: "Song", uploaderRaw: "Channel Name" }).find((item) => item.kind === "UPLOADER")!;
  const target = youtubeTarget({ titleRaw: "Song", artistRaw: undefined, uploaderRaw: "Channel Name" });
  const result = scoreCandidateForSource(
    { hypothesis, durationMs: 213_000 },
    candidate({ target, validation: providerValidation(target), titleRaw: "Song", artistRaw: undefined, uploaderRaw: "Channel Name", isrc: undefined }),
  );
  assert.ok(result.evidence.some((item) => item.signal === "ARTIST" && item.points === 0));
  assert.ok(result.evidence.some((item) => item.signal === "CONTEXT" && item.points > 0));
});

test("version mismatch is a hard anti-signal rather than punctuation discarded by normalization", () => {
  const hypothesis = buildTrackHypotheses({ titleRaw: "Song", artistRaw: "Artist" })[0]!;
  const target = youtubeTarget({ titleRaw: "Song (Karaoke)", durationMs: 213_000 });
  const scored = scoreCandidateForSource(
    { hypothesis, durationMs: 213_000 },
    candidate({ target, validation: providerValidation(target), titleRaw: "Song (Karaoke)", artistRaw: "Artist", isrc: undefined }),
  );
  assert.ok(scored.hardConflicts.includes("VERSION_MISMATCH"));
  assert.ok(scored.evidence.some((item) => item.detail.includes("Version mismatch")));
});
