import {
  createProviderValidation,
  type CandidateValidation,
  type Provider,
  type ProviderTrackReference,
} from "../domain/src/index.js";
import type { MatchCandidateInput } from "../matching/src/index.js";

/**
 * Every name in this corpus is generated and fictional.  The fixture can be
 * copied, modified and redistributed with the project (CC0-1.0).
 */
export const GOLD_DATASET_LICENSE = "CC0-1.0 synthetic data" as const;
export const GOLD_DATASET_VERSION = "synthetic-gold-v1" as const;
export const DEFAULT_GOLD_SEED = 0x5eed_2026;

export const PROVIDER_DIRECTIONS = [
  ["spotify", "soundcloud"],
  ["spotify", "youtube"],
  ["soundcloud", "spotify"],
  ["soundcloud", "youtube"],
  ["youtube", "spotify"],
  ["youtube", "soundcloud"],
] as const satisfies readonly (readonly [Provider, Provider])[];

export type ProviderDirection = (typeof PROVIDER_DIRECTIONS)[number];
export type GoldDifficulty = "CLEAR" | "HARD";
export type GoldChallenge =
  | "EXACT"
  | "HTML_AND_PUNCTUATION"
  | "DURATION_EDGE"
  | "ISRC_ALIAS"
  | "VERSION_COLLISION"
  | "CLOSE_MARGIN"
  | "MISSING_SIGNALS"
  | "UNAVAILABLE_TWIN"
  | "NO_MATCH";

export interface GoldSourceTrack {
  readonly provider: Provider;
  readonly titleRaw: string;
  readonly artistRaw: string;
  readonly durationMs?: number;
  readonly isrc?: string;
}

export interface GoldCase {
  readonly id: string;
  readonly direction: ProviderDirection;
  readonly difficulty: GoldDifficulty;
  readonly challenge: GoldChallenge;
  readonly source: GoldSourceTrack;
  readonly candidates: readonly MatchCandidateInput[];
  /** Null means the independent label says that no candidate is equivalent. */
  readonly expectedTargetId: string | null;
}

export interface GenerateGoldDatasetOptions {
  readonly perDirection?: number;
  readonly seed?: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function stableToken(value: number, length: number): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let state = (value + 1) >>> 0;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state ^ (state >>> 13), 1_664_525) + 1_013_904_223) >>> 0;
    output += alphabet[state % alphabet.length];
  }
  return output;
}

function targetId(provider: Provider, ordinal: number): string {
  if (provider === "spotify") return stableToken(ordinal, 22);
  if (provider === "youtube") return stableToken(ordinal, 11).replace(/[^A-Za-z0-9_-]/g, "A");
  return `https://soundcloud.com/synthetic-catalog/track-${ordinal + 1}`;
}

function targetUrl(provider: Provider, id: string): string {
  if (provider === "spotify") return `https://open.spotify.com/track/${id}`;
  if (provider === "youtube") return `https://www.youtube.com/watch?v=${id}`;
  return id;
}

function makeTarget(input: {
  readonly provider: Provider;
  readonly ordinal: number;
  readonly titleRaw: string;
  readonly artistRaw?: string;
  readonly durationMs?: number;
  readonly isrc?: string;
  readonly availability?: ProviderTrackReference["availability"];
}): ProviderTrackReference {
  const id = targetId(input.provider, input.ordinal);
  const url = targetUrl(input.provider, id);
  return {
    provider: input.provider,
    entityKind: input.provider === "youtube" ? "video" : "track",
    providerEntityId: id,
    ...(input.provider === "youtube" ? { videoId: id } : {}),
    providerUriOrUrl: input.provider === "spotify" ? `spotify:track:${id}` : url,
    containsSecretUrl: false,
    redactedDisplayUrl: url,
    titleRaw: input.titleRaw,
    artistRaw: input.artistRaw,
    durationMs: input.durationMs,
    isrc: input.isrc,
    availability: input.availability ?? "AVAILABLE",
    attributionUrl: url,
    fetchedAt: "2026-07-29T12:00:00.000Z",
  };
}

function validate(target: ProviderTrackReference): CandidateValidation & { readonly status: "PROVIDER_VALIDATED" } {
  return createProviderValidation(target, {
    kind: target.provider === "soundcloud" ? "PROVIDER_OEMBED" : "PROVIDER_API",
    provider: target.provider,
    providerEntityId: target.providerEntityId,
    checkedAt: "2026-07-29T12:01:00.000Z",
    exists: true,
    evidenceVersion: GOLD_DATASET_VERSION,
  });
}

interface CandidateSpec {
  readonly titleRaw: string;
  readonly artistRaw?: string;
  readonly durationMs?: number;
  readonly isrc?: string;
  readonly availability?: ProviderTrackReference["availability"];
  readonly context?: MatchCandidateInput["context"];
  readonly isExpected?: boolean;
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [output[index], output[other]] = [output[other]!, output[index]!];
  }
  return output;
}

function createCandidates(
  destination: Provider,
  caseOrdinal: number,
  specs: readonly CandidateSpec[],
  random: () => number,
): { readonly candidates: readonly MatchCandidateInput[]; readonly expectedTargetId: string | null } {
  const shuffled = shuffle(specs.map((spec, originalIndex) => ({ spec, originalIndex })), random);
  let expectedTargetId: string | null = null;
  const candidates = shuffled.map(({ spec, originalIndex }, providerRank) => {
    const target = makeTarget({
      provider: destination,
      ordinal: caseOrdinal * 16 + originalIndex,
      titleRaw: spec.titleRaw,
      artistRaw: spec.artistRaw,
      durationMs: spec.durationMs,
      isrc: spec.isrc,
      availability: spec.availability,
    });
    if (spec.isExpected) expectedTargetId = target.providerEntityId;
    return {
      target,
      validation: validate(target),
      titleRaw: spec.titleRaw,
      artistRaw: spec.artistRaw,
      durationMs: spec.durationMs,
      isrc: spec.isrc,
      providerRank: providerRank + 1,
      context: spec.context,
    } satisfies MatchCandidateInput;
  });
  return { candidates, expectedTargetId };
}

function clearSpecs(title: string, artist: string, durationMs: number, isrc: string): readonly CandidateSpec[] {
  return [
    {
      titleRaw: title,
      artistRaw: artist,
      durationMs,
      isrc,
      isExpected: true,
      context: { structuredArtist: true, official: true, licensed: true, topic: true },
    },
    { titleRaw: title, artistRaw: "Northbound Static", durationMs, context: { official: true } },
    { titleRaw: `${title} (Live)`, artistRaw: artist, durationMs: durationMs + 24_000 },
    { titleRaw: `${title} Reprise`, artistRaw: artist, durationMs: durationMs + 8_000 },
    { titleRaw: "Unrelated Harbor Theme", artistRaw: "Distant Ensemble", durationMs: 181_000 },
    { titleRaw: "Completely Different Signal", artistRaw: "Elsewhere Unit", durationMs: 247_000 },
  ];
}

function hardSpecs(
  challenge: Exclude<GoldChallenge, "EXACT">,
  title: string,
  artist: string,
  durationMs: number,
  isrc: string,
): { readonly source: Omit<GoldSourceTrack, "provider">; readonly specs: readonly CandidateSpec[] } {
  const ordinaryDistractors: readonly CandidateSpec[] = [
    { titleRaw: title, artistRaw: "Northbound Static", durationMs },
    { titleRaw: `${title} (Remix)`, artistRaw: artist, durationMs: durationMs + 18_000 },
    { titleRaw: `${title} Reprise`, artistRaw: artist, durationMs: durationMs + 7_000 },
    { titleRaw: "Unrelated Harbor Theme", artistRaw: "Distant Ensemble", durationMs: 181_000 },
    { titleRaw: "Completely Different Signal", artistRaw: "Elsewhere Unit", durationMs: 247_000 },
  ];

  if (challenge === "HTML_AND_PUNCTUATION") {
    const sourceTitle = `${title} & Dawn`;
    return {
      source: { titleRaw: sourceTitle, artistRaw: artist, durationMs, isrc },
      specs: [
        { titleRaw: `${title} &amp; Dawn`, artistRaw: artist, durationMs, isrc, isExpected: true, context: { structuredArtist: true, official: true, licensed: true, topic: true } },
        ...ordinaryDistractors,
      ],
    };
  }
  if (challenge === "DURATION_EDGE") {
    return {
      source: { titleRaw: title, artistRaw: artist, durationMs, isrc },
      specs: [
        { titleRaw: title, artistRaw: artist, durationMs: durationMs + Math.floor(durationMs * 0.029), isrc, isExpected: true, context: { structuredArtist: true, official: true, licensed: true, topic: true } },
        ...ordinaryDistractors,
      ],
    };
  }
  if (challenge === "ISRC_ALIAS") {
    return {
      source: { titleRaw: `Catalog Alias ${title}`, artistRaw: artist, durationMs, isrc },
      specs: [
        { titleRaw: `Studio Master ${title}`, artistRaw: artist, durationMs, isrc, isExpected: true, context: { structuredArtist: true, official: true, licensed: true, topic: true } },
        ...ordinaryDistractors,
      ],
    };
  }
  if (challenge === "VERSION_COLLISION") {
    const liveTitle = `${title} (Live)`;
    return {
      source: { titleRaw: liveTitle, artistRaw: artist, durationMs, isrc },
      specs: [
        { titleRaw: liveTitle, artistRaw: artist, durationMs, isrc, isExpected: true, context: { structuredArtist: true, official: true, licensed: true, topic: true } },
        { titleRaw: title, artistRaw: artist, durationMs: durationMs - 17_000, context: { official: true, licensed: true } },
        ...ordinaryDistractors.slice(1),
      ],
    };
  }
  if (challenge === "CLOSE_MARGIN") {
    return {
      source: { titleRaw: title, artistRaw: artist, durationMs, isrc },
      specs: [
        { titleRaw: title, artistRaw: artist, durationMs, isExpected: true },
        { titleRaw: title, artistRaw: artist, durationMs: durationMs + 1_000, context: { official: true } },
        ...ordinaryDistractors.slice(1),
      ],
    };
  }
  if (challenge === "MISSING_SIGNALS") {
    return {
      source: { titleRaw: title, artistRaw: artist, durationMs, isrc },
      specs: [
        { titleRaw: title, isExpected: true, context: { official: true } },
        ...ordinaryDistractors,
      ],
    };
  }
  if (challenge === "UNAVAILABLE_TWIN") {
    return {
      source: { titleRaw: title, artistRaw: artist, durationMs, isrc },
      specs: [
        { titleRaw: title, artistRaw: artist, durationMs, isrc, isExpected: true, context: { structuredArtist: true, official: true, licensed: true, topic: true } },
        { titleRaw: title, artistRaw: artist, durationMs, availability: "UNAVAILABLE" },
        ...ordinaryDistractors.slice(1),
      ],
    };
  }
  return {
    source: { titleRaw: title, artistRaw: artist, durationMs, isrc },
    specs: [
      { titleRaw: `${title} (Cover)`, artistRaw: "Tribute Assembly", durationMs },
      { titleRaw: title, artistRaw: "Different Primary Artist", durationMs },
      { titleRaw: `${title} (Remix)`, artistRaw: artist, durationMs: durationMs + 35_000 },
      { titleRaw: "Unrelated Harbor Theme", artistRaw: "Distant Ensemble", durationMs: 181_000 },
      { titleRaw: "Completely Different Signal", artistRaw: "Elsewhere Unit", durationMs: 247_000 },
      { titleRaw: "Another Catalog Entry", artistRaw: "Unknown Unit", durationMs: 199_000 },
    ],
  };
}

const HARD_CHALLENGES = [
  "HTML_AND_PUNCTUATION",
  "DURATION_EDGE",
  "ISRC_ALIAS",
  "VERSION_COLLISION",
  "CLOSE_MARGIN",
  "MISSING_SIGNALS",
  "UNAVAILABLE_TWIN",
  "NO_MATCH",
] as const;

/** Generates exactly the same provider-neutral labelled corpus for a given seed. */
export function generateGoldDataset(options: GenerateGoldDatasetOptions = {}): readonly GoldCase[] {
  const perDirection = options.perDirection ?? 300;
  if (!Number.isSafeInteger(perDirection) || perDirection < 300) {
    throw new RangeError("Gold data must contain at least 300 cases per provider direction");
  }
  const random = mulberry32(options.seed ?? DEFAULT_GOLD_SEED);
  const cases: GoldCase[] = [];
  let globalOrdinal = 0;

  for (const direction of PROVIDER_DIRECTIONS) {
    const hardCount = Math.ceil(perDirection / 2);
    for (let localOrdinal = 0; localOrdinal < perDirection; localOrdinal += 1) {
      const [sourceProvider, destinationProvider] = direction;
      const title = `Signal ${globalOrdinal + 1} at Midnight`;
      const artist = `Synthetic Artist ${(globalOrdinal % 97) + 1}`;
      const durationMs = 165_000 + (globalOrdinal % 151) * 1_000;
      const isrc = `ZZSYN${String(globalOrdinal % 100).padStart(2, "0")}${String(globalOrdinal).padStart(5, "0").slice(-5)}`;
      const difficulty: GoldDifficulty = localOrdinal < hardCount ? "HARD" : "CLEAR";
      const challenge: GoldChallenge = difficulty === "CLEAR"
        ? "EXACT"
        : HARD_CHALLENGES[localOrdinal % HARD_CHALLENGES.length];
      const generated = challenge === "EXACT"
        ? {
            source: { titleRaw: title, artistRaw: artist, durationMs, isrc },
            specs: clearSpecs(title, artist, durationMs, isrc),
          }
        : hardSpecs(challenge, title, artist, durationMs, isrc);
      const candidateResult = createCandidates(destinationProvider, globalOrdinal, generated.specs, random);
      cases.push({
        id: `gold-${sourceProvider}-${destinationProvider}-${String(localOrdinal + 1).padStart(3, "0")}`,
        direction,
        difficulty,
        challenge,
        source: { provider: sourceProvider, ...generated.source },
        candidates: candidateResult.candidates,
        expectedTargetId: candidateResult.expectedTargetId,
      });
      globalOrdinal += 1;
    }
  }
  return Object.freeze(cases);
}
