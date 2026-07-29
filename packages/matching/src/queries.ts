import type { Provider } from "../../domain/src/index.js";
import type { TrackHypothesis } from "./types.js";

export type SearchQueryKind = "ISRC" | "EXACT_STRUCTURED" | "NORMALIZED" | "DASH" | "ALTERNATE" | "TITLE_ONLY";

export interface SearchQueryVariant {
  readonly kind: SearchQueryKind;
  readonly query: string;
  readonly isFallback: boolean;
}

function quote(value: string): string {
  return `"${value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()}"`;
}

function formatted(provider: Provider, title: string, artist: string | undefined): string {
  if (provider === "spotify") {
    return artist ? `track:${quote(title)} artist:${quote(artist)}` : `track:${quote(title)}`;
  }
  return artist ? `${artist} - ${title}` : title;
}

export function buildSearchQueries(input: {
  readonly provider: Provider;
  readonly hypotheses: readonly TrackHypothesis[];
  readonly isrc?: string;
  readonly supportsIsrc?: boolean;
}): readonly SearchQueryVariant[] {
  if (input.hypotheses.length === 0) return [];
  const output: SearchQueryVariant[] = [];
  const seen = new Set<string>();
  const add = (kind: SearchQueryKind, query: string, isFallback: boolean): void => {
    const clean = query.replace(/\s+/g, " ").trim();
    const key = clean.toLocaleLowerCase("und");
    if (clean && !seen.has(key)) {
      seen.add(key);
      output.push({ kind, query: clean, isFallback });
    }
  };

  if (input.isrc?.trim() && input.supportsIsrc) {
    add("ISRC", input.provider === "spotify" ? `isrc:${input.isrc.trim()}` : input.isrc.trim(), false);
  }
  const first = input.hypotheses[0]!;
  add("EXACT_STRUCTURED", formatted(input.provider, first.titleRaw, first.artistRaw), false);
  add("NORMALIZED", formatted(input.provider, first.title.core, first.artist?.normalized), false);
  if (first.artistRaw) add("DASH", `${first.artistRaw} - ${first.titleRaw}`, false);
  const alternate = input.hypotheses.find((hypothesis) => hypothesis !== first && hypothesis.artistRaw);
  if (alternate) add("ALTERNATE", formatted(input.provider, alternate.titleRaw, alternate.artistRaw), true);
  add("TITLE_ONLY", formatted(input.provider, first.titleRaw, undefined), true);

  if (input.provider === "youtube") {
    // One broad query and at most one fallback: quota is a hard product constraint.
    const nonIsrc = output.filter((query) => query.kind !== "ISRC");
    const primary = nonIsrc.find((query) => !query.isFallback) ?? nonIsrc[0];
    const fallback = nonIsrc.find((query) => query.isFallback && query.query !== primary?.query);
    return [primary, fallback].filter((query): query is SearchQueryVariant => Boolean(query));
  }
  return output;
}
