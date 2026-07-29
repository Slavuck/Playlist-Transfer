import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTrackHypotheses,
  decodeHtmlEntities,
  extractFeaturedContributors,
  extractVersionMarkers,
  foldDiacritics,
  normalizeText,
  normalizeTrackTitle,
  parseArtistTitleDash,
  toSearchTokens,
  transliterateCyrillic,
} from "../../packages/matching/src/index.js";

test("normalization decodes HTML, applies NFKC/casefold and keeps raw evidence", () => {
  const result = normalizeText("  ＣＡＦÉ&nbsp;—  Straße “Ёлка”  ", "ru");
  assert.equal(result.raw, "  ＣＡＦÉ&nbsp;—  Straße “Ёлка”  ");
  assert.equal(result.decoded.includes("&nbsp;"), false);
  assert.equal(result.normalized, "café strasse ёлка");
  assert.equal(result.foldedDiacritics, "cafe strasse елка");
  assert.equal(result.localeVariant, "café strasse елка");
  assert.deepEqual(result.tokens, ["café", "strasse", "ёлка"]);
  assert.equal(decodeHtmlEntities("A &amp; B &#x2014; C"), "A & B — C");
  assert.equal(foldDiacritics("Crème Brûlée"), "Creme Brulee");
});

test("version markers survive normalization and are removed only from title core", () => {
  const title = normalizeTrackTitle("Song Name (Live Remix) [2024 Remaster]");
  assert.deepEqual(new Set(title.versionMarkers), new Set(["LIVE", "REMIX", "REMASTER"]));
  assert.equal(title.core, "song name");
  assert.deepEqual(extractVersionMarkers("sped up + reverb instrumental"), ["SPED_UP", "INSTRUMENTAL", "REVERB"]);
  assert.deepEqual(extractVersionMarkers("ordinary song"), []);
});

test("artist/title and featured-contributor parsing remains conservative", () => {
  assert.deepEqual(parseArtistTitleDash("Massive Attack — Teardrop"), { artist: "Massive Attack", title: "Teardrop" });
  assert.equal(parseArtistTitleDash("AC-DC"), null);
  assert.deepEqual(extractFeaturedContributors("Song feat. Alice & Bob"), {
    base: "Song",
    contributors: ["Alice", "Bob"],
  });
  assert.deepEqual(extractFeaturedContributors("Xylophone"), { base: "Xylophone", contributors: [] });
});

test("transliteration is an additional variant and never replaces raw Cyrillic", () => {
  assert.equal(transliterateCyrillic("Ёлка — Прованс"), "Yolka — Provans");
  assert.equal(transliterateCyrillic("Radiohead"), null);
});

test("hypothesis builder preserves raw structured data while adding bounded alternatives", () => {
  const hypotheses = buildTrackHypotheses({
    titleRaw: "Би-2 — Полковнику никто не пишет (Live) feat. Гость",
    artistRaw: "Би-2",
    uploaderRaw: "Music Channel",
    locale: "ru",
  });
  assert.ok(hypotheses.length <= 8);
  assert.equal(hypotheses[0]?.kind, "STRUCTURED");
  assert.equal(hypotheses[0]?.titleRaw, "Би-2 — Полковнику никто не пишет (Live) feat. Гость");
  assert.ok(hypotheses.some((item) => item.kind === "UPLOADER"));
  assert.ok(hypotheses.some((item) => item.kind === "PARSED_DASH"));
  assert.ok(hypotheses.some((item) => item.kind === "FEATURED_CONTRIBUTORS"));
  assert.ok(hypotheses.some((item) => item.kind === "TRANSLITERATION"));
  assert.ok(hypotheses.some((item) => item.title.versionMarkers.includes("LIVE")));
});

test("stop words are removable only in a derived search token list", () => {
  const text = normalizeText("The Sound of Music");
  assert.deepEqual(toSearchTokens(text, new Set(["the", "of"])), ["sound", "music"]);
  assert.deepEqual(text.tokens, ["the", "sound", "of", "music"]);
});
