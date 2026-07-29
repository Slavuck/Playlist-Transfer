export interface YoutubeQuotaModel {
  readonly modelId: string;
  readonly asOf: string;
  readonly searchCallsPerDay: number;
  readonly generalUnitsPerDay: number;
  readonly costs: {
    readonly playlistItemsInsert: number;
    readonly playlistsInsert: number;
    readonly playlistImagesInsert: number;
    readonly listOrEnrichment: number;
  };
}

/** Versioned starting model from Plan_Playlist-Transfer; adapters may inject a refreshed model. */
export const YOUTUBE_QUOTA_MODEL_2026_07_29: YoutubeQuotaModel = Object.freeze({
  modelId: "youtube-data-api-guided-baseline-2026-07-29",
  asOf: "2026-07-29",
  searchCallsPerDay: 100,
  generalUnitsPerDay: 10_000,
  costs: Object.freeze({
    playlistItemsInsert: 50,
    playlistsInsert: 50,
    playlistImagesInsert: 50,
    listOrEnrichment: 1,
  }),
});

export interface YoutubeQuotaEstimateInput {
  readonly uniquePrimarySearches: number;
  readonly fallbackSearches?: number;
  readonly playlistItemInserts: number;
  readonly playlistCreates?: number;
  readonly coverUploads?: number;
  readonly enrichmentCalls?: number;
  readonly listCalls?: number;
  readonly verificationCalls?: number;
}

export interface YoutubeQuotaEstimate {
  readonly modelId: string;
  readonly modelAsOf: string;
  readonly searchBucketCalls: number;
  readonly generalUnits: number;
  readonly breakdown: {
    readonly inserts: number;
    readonly playlistCreates: number;
    readonly coverUploads: number;
    readonly enrichmentAndLists: number;
  };
}

function assertCount(value: number | undefined, field: string): number {
  const count = value ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`${field} must be a non-negative integer`);
  return count;
}

export function estimateYoutubeQuota(
  input: YoutubeQuotaEstimateInput,
  model: YoutubeQuotaModel = YOUTUBE_QUOTA_MODEL_2026_07_29,
): YoutubeQuotaEstimate {
  const searches = assertCount(input.uniquePrimarySearches, "uniquePrimarySearches");
  const fallbacks = assertCount(input.fallbackSearches, "fallbackSearches");
  const inserts = assertCount(input.playlistItemInserts, "playlistItemInserts") * model.costs.playlistItemsInsert;
  const playlistCreates = assertCount(input.playlistCreates, "playlistCreates") * model.costs.playlistsInsert;
  const coverUploads = assertCount(input.coverUploads, "coverUploads") * model.costs.playlistImagesInsert;
  const listCount =
    assertCount(input.enrichmentCalls, "enrichmentCalls") +
    assertCount(input.listCalls, "listCalls") +
    assertCount(input.verificationCalls, "verificationCalls");
  const enrichmentAndLists = listCount * model.costs.listOrEnrichment;

  return {
    modelId: model.modelId,
    modelAsOf: model.asOf,
    searchBucketCalls: searches + fallbacks,
    generalUnits: inserts + playlistCreates + coverUploads + enrichmentAndLists,
    breakdown: { inserts, playlistCreates, coverUploads, enrichmentAndLists },
  };
}

export interface YoutubeQuotaAvailability {
  readonly canStartWithoutCreatingEmptyPlaylist: boolean;
  readonly searchCallsShortfall: number;
  readonly generalUnitsShortfall: number;
  readonly utilization: { readonly search: number; readonly general: number };
}

export function assessYoutubeQuota(
  estimate: YoutubeQuotaEstimate,
  available: { readonly searchCalls: number; readonly generalUnits: number },
): YoutubeQuotaAvailability {
  const searchCalls = assertCount(available.searchCalls, "available.searchCalls");
  const generalUnits = assertCount(available.generalUnits, "available.generalUnits");
  const searchCallsShortfall = Math.max(0, estimate.searchBucketCalls - searchCalls);
  const generalUnitsShortfall = Math.max(0, estimate.generalUnits - generalUnits);
  return {
    canStartWithoutCreatingEmptyPlaylist: searchCallsShortfall === 0 && generalUnitsShortfall === 0,
    searchCallsShortfall,
    generalUnitsShortfall,
    utilization: {
      search: searchCalls === 0 ? (estimate.searchBucketCalls === 0 ? 0 : Infinity) : estimate.searchBucketCalls / searchCalls,
      general: generalUnits === 0 ? (estimate.generalUnits === 0 ? 0 : Infinity) : estimate.generalUnits / generalUnits,
    },
  };
}

export function estimateYoutubeTransferQuota(
  trackCount: number,
  options: {
    readonly uniquePrimarySearches?: number;
    readonly fallbackSearches?: number;
    readonly destinationPlaylistCreates?: number;
    readonly coverUploads?: number;
    readonly enrichmentBatchSize?: number;
    readonly verificationPageSize?: number;
  } = {},
  model: YoutubeQuotaModel = YOUTUBE_QUOTA_MODEL_2026_07_29,
): YoutubeQuotaEstimate {
  const count = assertCount(trackCount, "trackCount");
  const enrichmentBatchSize = options.enrichmentBatchSize ?? 50;
  const verificationPageSize = options.verificationPageSize ?? 50;
  if (!Number.isSafeInteger(enrichmentBatchSize) || enrichmentBatchSize <= 0) throw new RangeError("enrichmentBatchSize must be positive");
  if (!Number.isSafeInteger(verificationPageSize) || verificationPageSize <= 0) throw new RangeError("verificationPageSize must be positive");

  return estimateYoutubeQuota(
    {
      uniquePrimarySearches: options.uniquePrimarySearches ?? count,
      fallbackSearches: options.fallbackSearches,
      playlistItemInserts: count,
      playlistCreates: options.destinationPlaylistCreates,
      coverUploads: options.coverUploads,
      enrichmentCalls: count === 0 ? 0 : Math.ceil(count / enrichmentBatchSize),
      verificationCalls: count === 0 ? 0 : Math.ceil(count / verificationPageSize),
    },
    model,
  );
}

export function estimateSpotifyAppendRequests(itemCount: number, batchSize = 100): number {
  const count = assertCount(itemCount, "itemCount");
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 100) {
    throw new RangeError("Spotify batchSize must be between 1 and 100");
  }
  return count === 0 ? 0 : Math.ceil(count / batchSize);
}

export function estimateSoundcloudFullListWrite(finalItemCount: number): { readonly calls: 0 | 1; readonly withinLimit: boolean } {
  const count = assertCount(finalItemCount, "finalItemCount");
  return { calls: count === 0 ? 0 : 1, withinLimit: count <= 500 };
}
