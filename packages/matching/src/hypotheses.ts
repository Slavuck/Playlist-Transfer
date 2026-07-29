import {
  extractFeaturedContributors,
  normalizeText,
  normalizeTrackTitle,
  parseArtistTitleDash,
  parseTitleByArtist,
  transliterateCyrillic,
} from "./normalization.js";
import type { HypothesisKind, TrackHypothesis } from "./types.js";

export interface SourceTrackMetadata {
  readonly titleRaw: string;
  readonly artistRaw?: string;
  readonly artistsRaw?: readonly string[];
  readonly metadataArtistRaw?: string;
  readonly uploaderRaw?: string;
  readonly channelRaw?: string;
  readonly locale?: string;
}

function createHypothesis(
  kind: HypothesisKind,
  titleRaw: string,
  artistRaw: string | undefined,
  contributorsRaw: readonly string[],
  sourceFields: readonly string[],
  locale: string,
): TrackHypothesis {
  return {
    kind,
    titleRaw,
    artistRaw,
    contributorsRaw,
    title: normalizeTrackTitle(titleRaw, locale),
    artist: artistRaw ? normalizeText(artistRaw, locale) : undefined,
    contributors: contributorsRaw.map((contributor) => normalizeText(contributor, locale)),
    sourceFields,
  };
}

function keyForHypothesis(hypothesis: TrackHypothesis): string {
  return [
    hypothesis.title.core,
    hypothesis.artist?.normalized ?? "",
    hypothesis.contributors.map((item) => item.normalized).sort().join(","),
    [...hypothesis.title.versionMarkers].sort().join(","),
  ].join("|");
}

export function buildTrackHypotheses(metadata: SourceTrackMetadata, maxHypotheses = 8): readonly TrackHypothesis[] {
  if (!metadata.titleRaw.trim()) throw new TypeError("Source title is required");
  if (!Number.isSafeInteger(maxHypotheses) || maxHypotheses < 1) throw new RangeError("maxHypotheses must be positive");
  const locale = metadata.locale ?? "und";
  const primaryArtist = metadata.artistRaw ?? metadata.artistsRaw?.filter(Boolean).join(", ") ?? metadata.metadataArtistRaw;
  const output: TrackHypothesis[] = [];
  const seen = new Set<string>();

  const add = (hypothesis: TrackHypothesis): void => {
    const key = keyForHypothesis(hypothesis);
    if (!seen.has(key) && output.length < maxHypotheses) {
      seen.add(key);
      output.push(hypothesis);
    }
  };

  add(createHypothesis("STRUCTURED", metadata.titleRaw, primaryArtist, [], ["title", "structured_artist"], locale));

  const uploader = metadata.uploaderRaw ?? metadata.channelRaw;
  if (uploader) add(createHypothesis("UPLOADER", metadata.titleRaw, uploader, [], ["title", "uploader_or_channel"], locale));

  const dash = parseArtistTitleDash(metadata.titleRaw);
  if (dash) add(createHypothesis("PARSED_DASH", dash.title, dash.artist, [], ["parsed_title"], locale));

  const byArtist = parseTitleByArtist(metadata.titleRaw);
  if (byArtist) add(createHypothesis("PARSED_TITLE_ARTIST", byArtist.title, byArtist.artist, [], ["parsed_title"], locale));

  const titleFeaturing = extractFeaturedContributors(metadata.titleRaw);
  const artistFeaturing = primaryArtist ? extractFeaturedContributors(primaryArtist) : null;
  const contributors = [...titleFeaturing.contributors, ...(artistFeaturing?.contributors ?? [])];
  if (contributors.length > 0) {
    add(
      createHypothesis(
        "FEATURED_CONTRIBUTORS",
        titleFeaturing.base,
        artistFeaturing?.base ?? primaryArtist,
        contributors,
        ["title", "featured_contributors"],
        locale,
      ),
    );
  }

  if (normalizeTrackTitle(metadata.titleRaw, locale).versionMarkers.length > 0) {
    add(createHypothesis("VERSION_PRESERVING", metadata.titleRaw, primaryArtist, contributors, ["title", "version_markers"], locale));
  }

  const transliteratedTitle = transliterateCyrillic(metadata.titleRaw);
  const transliteratedArtist = primaryArtist ? transliterateCyrillic(primaryArtist) : null;
  if (transliteratedTitle || transliteratedArtist) {
    add(
      createHypothesis(
        "TRANSLITERATION",
        transliteratedTitle ?? metadata.titleRaw,
        transliteratedArtist ?? primaryArtist,
        contributors.map((item) => transliterateCyrillic(item) ?? item),
        ["transliteration"],
        locale,
      ),
    );
  }

  return output;
}
