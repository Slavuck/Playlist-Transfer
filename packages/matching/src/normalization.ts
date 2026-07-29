import type { NormalizedText, NormalizedTrackTitle, VersionMarker } from "./types.js";

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  quot: '"',
};

const VERSION_PATTERNS: readonly [VersionMarker, RegExp][] = [
  ["SPED_UP", /\b(?:sped\s*up|nightcore|ускоренн(?:ая|о|ый))\b/iu],
  ["SLOWED", /\b(?:slowed(?:\s*down)?|замедленн(?:ая|о|ый))\b/iu],
  ["INSTRUMENTAL", /\b(?:instrumental|инструментал(?:ьная|ьный)?)\b/iu],
  ["KARAOKE", /\b(?:karaoke|караоке)\b/iu],
  ["REMASTER", /\b(?:re-?master(?:ed)?|ремастер(?:инг)?)\b/iu],
  ["REMIX", /\b(?:re-?mix|rmx|ремикс)\b/iu],
  ["REVERB", /\b(?:reverb(?:ed)?|реверб)\b/iu],
  ["ACOUSTIC", /\b(?:acoustic|акустическ(?:ая|ий|ое))\b/iu],
  ["KARAOKE", /\bkaraoke\b/iu],
  ["COVER", /\b(?:cover|кавер)\b/iu],
  ["LIVE", /\b(?:live|concert|session|лайв|концерт(?:ная|ный)?)\b/iu],
  ["EDIT", /\b(?:radio\s+edit|edit|версия\s+для\s+радио)\b/iu],
];

const VERSION_REMOVAL_PATTERNS = VERSION_PATTERNS.map(([, pattern]) =>
  new RegExp(pattern.source, pattern.flags.replace("u", "gu")),
);

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/giu, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const point = Number.parseInt(lower.slice(2), 16);
      return Number.isSafeInteger(point) && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    if (lower.startsWith("#")) {
      const point = Number.parseInt(lower.slice(1), 10);
      return Number.isSafeInteger(point) && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return HTML_ENTITIES[lower] ?? whole;
  });
}

function fullCaseFold(value: string, locale: string): string {
  return value.toLocaleLowerCase(locale).replace(/ß/g, "ss").replace(/ς/g, "σ");
}

function normalizeSpacingAndPunctuation(value: string): string {
  return value
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function foldDiacritics(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}+/gu, "").normalize("NFKC");
}

export function tokenizeNormalized(value: string): readonly string[] {
  return value ? value.split(" ").filter(Boolean) : [];
}

export function normalizeText(raw: string, locale = "und"): NormalizedText {
  const decoded = decodeHtmlEntities(raw);
  const normalized = normalizeSpacingAndPunctuation(fullCaseFold(decoded.normalize("NFKC"), locale));
  const foldedDiacritics = normalizeSpacingAndPunctuation(foldDiacritics(normalized));
  const yoVariant = normalized.includes("ё") ? normalized.replace(/ё/g, "е") : undefined;
  return {
    raw,
    decoded,
    normalized,
    foldedDiacritics,
    localeVariant: yoVariant,
    tokens: tokenizeNormalized(normalized),
  };
}

export function extractVersionMarkers(raw: string): readonly VersionMarker[] {
  const normalized = decodeHtmlEntities(raw).normalize("NFKC");
  const markers = new Set<VersionMarker>();
  for (const [marker, pattern] of VERSION_PATTERNS) {
    if (pattern.test(normalized)) markers.add(marker);
  }
  return [...markers];
}

function removeVersionPhrases(value: string): string {
  let result = value;
  for (const pattern of VERSION_REMOVAL_PATTERNS) result = result.replace(pattern, " ");
  return result.replace(/[()[\]{}]/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeTrackTitle(raw: string, locale = "und"): NormalizedTrackTitle {
  const base = normalizeText(raw, locale);
  const versionMarkers = extractVersionMarkers(raw);
  // Only bracket groups carrying a known version marker are discarded from the core.
  const withoutVersionGroups = base.decoded.replace(/[([{]([^\])}]+)[\])}]/g, (whole, inside: string) =>
    extractVersionMarkers(inside).length > 0 ? " " : whole,
  );
  const core = normalizeText(removeVersionPhrases(withoutVersionGroups), locale).normalized;
  return { ...base, core, coreTokens: tokenizeNormalized(core), versionMarkers };
}

export interface ParsedArtistTitle {
  readonly artist: string;
  readonly title: string;
}

export function parseArtistTitleDash(raw: string): ParsedArtistTitle | null {
  const decoded = decodeHtmlEntities(raw).normalize("NFKC");
  const match = /^\s*(.+?)\s+[‐‑‒–—―-]\s+(.+?)\s*$/.exec(decoded);
  if (!match?.[1]?.trim() || !match[2]?.trim()) return null;
  return { artist: match[1].trim(), title: match[2].trim() };
}

export function parseTitleByArtist(raw: string): ParsedArtistTitle | null {
  const decoded = decodeHtmlEntities(raw).normalize("NFKC");
  const match = /^\s*(.+?)\s+by\s+(.+?)\s*$/iu.exec(decoded);
  if (!match?.[1]?.trim() || !match[2]?.trim()) return null;
  return { artist: match[2].trim(), title: match[1].trim() };
}

export interface FeaturedParts {
  readonly base: string;
  readonly contributors: readonly string[];
}

export function extractFeaturedContributors(raw: string): FeaturedParts {
  const match = /^(.*?)\s+(?:feat(?:uring)?\.?|ft\.?|with|x)\s+(.+)$/iu.exec(raw.trim());
  if (!match?.[1]?.trim() || !match[2]?.trim()) return { base: raw.trim(), contributors: [] };
  return {
    base: match[1].trim(),
    contributors: match[2].split(/\s*(?:,|&|\band\b)\s*/iu).map((value) => value.trim()).filter(Boolean),
  };
}

const CYRILLIC_MAP: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

export function transliterateCyrillic(raw: string): string | null {
  if (!/\p{Script=Cyrillic}/u.test(raw)) return null;
  return Array.from(raw).map((character) => {
    const lower = character.toLocaleLowerCase("ru");
    const transliterated = CYRILLIC_MAP[lower];
    if (transliterated === undefined) return character;
    return character === lower ? transliterated : transliterated.charAt(0).toUpperCase() + transliterated.slice(1);
  }).join("");
}

/** Search-only stop-word removal. Scoring callers must use the untouched tokens. */
export function toSearchTokens(text: NormalizedText, stopWords: ReadonlySet<string>): readonly string[] {
  return text.tokens.filter((token) => !stopWords.has(token));
}
