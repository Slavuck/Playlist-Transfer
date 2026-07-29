import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchQueries, buildTrackHypotheses } from "../../packages/matching/src/index.js";

test("Spotify queries start with ISRC then structured/normalized variants", () => {
  const hypotheses = buildTrackHypotheses({ titleRaw: "Song (Live)", artistRaw: "Artist", uploaderRaw: "Uploader" });
  const queries = buildSearchQueries({ provider: "spotify", hypotheses, isrc: "USRC17607839", supportsIsrc: true });
  assert.equal(queries[0]?.query, "isrc:USRC17607839");
  assert.equal(queries[1]?.kind, "EXACT_STRUCTURED");
  assert.match(queries[1]?.query ?? "", /track:"Song \(Live\)" artist:"Artist"/);
  assert.ok(queries.some((item) => item.kind === "TITLE_ONLY"));
  assert.equal(new Set(queries.map((item) => item.query.toLowerCase())).size, queries.length);
});

test("YouTube emits one broad query and at most one fallback", () => {
  const hypotheses = buildTrackHypotheses({ titleRaw: "Artist — Song", artistRaw: "Artist", uploaderRaw: "Uploader" });
  const queries = buildSearchQueries({ provider: "youtube", hypotheses, supportsIsrc: false });
  assert.ok(queries.length >= 1 && queries.length <= 2);
  assert.equal(queries[0]?.isFallback, false);
  assert.ok(queries.filter((item) => item.isFallback).length <= 1);
});

test("query generation never mutates normalized evidence or invents queries without hypotheses", () => {
  assert.deepEqual(buildSearchQueries({ provider: "soundcloud", hypotheses: [] }), []);
  const hypotheses = buildTrackHypotheses({ titleRaw: "The Sound of Music", artistRaw: "Cast" });
  const before = hypotheses[0]?.title.tokens;
  buildSearchQueries({ provider: "soundcloud", hypotheses });
  assert.deepEqual(hypotheses[0]?.title.tokens, before);
});
