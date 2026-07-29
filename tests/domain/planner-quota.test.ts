import assert from "node:assert/strict";
import test from "node:test";
import {
  assessYoutubeQuota,
  createItemIdempotencyKey,
  createTransferBlueprint,
  createTransferSettings,
  estimateSoundcloudFullListWrite,
  estimateSpotifyAppendRequests,
  estimateYoutubeTransferQuota,
  materializeWritePlan,
  type PlannerSourcePlaylist,
  type ProviderTrackReference,
} from "../../packages/domain/src/index.js";
import { providerValidation, spotifyTarget, youtubeTarget } from "./fixtures.js";

function source(
  sourcePlaylistId: string,
  targets: readonly ProviderTrackReference[],
  strategy: "API" | "GUIDED_USER_ACTION" = "API",
): PlannerSourcePlaylist {
  return {
    sourcePlaylistId,
    title: `List ${sourcePlaylistId}`,
    selectedItems: targets.map((target, sourcePosition) => ({
      sourceItemId: `${sourcePlaylistId}-${sourcePosition}`,
      sourcePosition,
      target,
      validation: providerValidation(target),
      selectionKind: "MATCHED_AUTO",
      writeStrategy: strategy,
    })),
  };
}

test("separate-copy planner preserves duplicate positions and binds real destination IDs later", () => {
  const same = youtubeTarget();
  const blueprint = createTransferBlueprint({
    transferId: "transfer-1",
    destinationProvider: "youtube",
    mode: "SEPARATE_COPY",
    sources: [source("source-a", [same, same])],
    settings: createTransferSettings(),
  });
  assert.equal(blueprint.destinations.length, 1);
  assert.equal(blueprint.destinations[0]?.items.length, 2);
  assert.throws(() => materializeWritePlan(blueprint), /Missing real destination playlist ID/);

  const key = blueprint.destinations[0]!.destinationPlanKey;
  const plan = materializeWritePlan(blueprint, { [key]: "PL1234567890" });
  assert.equal(plan.expectedPlaylistCreates, 1);
  assert.equal(plan.expectedItemWrites, 2);
  assert.notEqual(plan.destinations[0]?.items[0]?.idempotencyKey, plan.destinations[0]?.items[1]?.idempotencyKey);
  assert.deepEqual(plan.destinations[0]?.items.map((item) => item.sourcePosition), [0, 1]);
});

test("idempotency tuple includes source playlist and source position without ambiguous concatenation", () => {
  const common = { transferId: "ab", destinationPlaylistId: "c", selectedTargetId: "target" };
  const first = createItemIdempotencyKey({ ...common, sourcePlaylistId: "d", sourcePosition: 12 });
  const second = createItemIdempotencyKey({ ...common, sourcePlaylistId: "d1", sourcePosition: 2 });
  assert.notEqual(first, second);
  assert.equal(first, createItemIdempotencyKey({ ...common, sourcePlaylistId: "d", sourcePosition: 12 }));
});

test("merge mode applies explicit target-ID dedupe across selected playlists", () => {
  const duplicate = youtubeTarget();
  const other = youtubeTarget({
    providerEntityId: "aaaaaaaaaaa", videoId: "aaaaaaaaaaa",
    providerUriOrUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    redactedDisplayUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    attributionUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
  });
  const blueprint = createTransferBlueprint({
    transferId: "transfer-merge", destinationProvider: "youtube", mode: "MERGE_NEW",
    mergedMetadata: { title: "Merged", privacy: "PRIVATE" },
    sources: [source("a", [duplicate, other]), source("b", [duplicate])],
    settings: createTransferSettings({ preserveDuplicates: false, dedupe: "TARGET_ID" }),
  });
  assert.equal(blueprint.destinations[0]?.items.length, 2);
  assert.equal(blueprint.omittedDuplicateCount, 1);
  assert.deepEqual(blueprint.destinations[0]?.sourcePlaylistIds, ["a", "b"]);
});

test("append-existing dedupes against read-before-write IDs and keeps existing items", () => {
  const duplicate = youtubeTarget();
  const blueprint = createTransferBlueprint({
    transferId: "append", destinationProvider: "youtube", mode: "APPEND_EXISTING",
    sources: [source("a", [duplicate])],
    settings: createTransferSettings({ preserveDuplicates: false, dedupe: "TARGET_ID" }),
    existingDestination: {
      providerPlaylistId: "PL1234567890", title: "Existing", eligibility: "PROVIDER_VERIFIED_OWNED",
      existingProviderEntityIds: [duplicate.providerEntityId], currentItemCount: 1,
    },
  });
  assert.equal(blueprint.destinations.length, 0);
  assert.equal(blueprint.omittedDuplicateCount, 1);
});

test("API plans reject user-only validation while guided plans retain honest status", () => {
  const target = youtubeTarget();
  const invalidSource: PlannerSourcePlaylist = {
    sourcePlaylistId: "s", title: "S", selectedItems: [{
      sourceItemId: "i", sourcePosition: 0, target,
      validation: { status: "USER_SELECTED_UNVERIFIED" }, selectionKind: "USER_SELECTED", writeStrategy: "API",
    }],
  };
  assert.throws(() => createTransferBlueprint({
    transferId: "t", destinationProvider: "youtube", mode: "SEPARATE_COPY",
    sources: [invalidSource], settings: createTransferSettings(),
  }), /API writes require/);

  const guidedSource: PlannerSourcePlaylist = {
    ...invalidSource,
    selectedItems: [{ ...invalidSource.selectedItems[0]!, writeStrategy: "GUIDED_USER_ACTION" }],
  };
  assert.equal(createTransferBlueprint({
    transferId: "t", destinationProvider: "youtube", mode: "SEPARATE_COPY",
    sources: [guidedSource], settings: createTransferSettings(),
  }).destinations.length, 1);
});

test("SoundCloud new destinations split only under the confirmed overflow policy", () => {
  const targets = Array.from({ length: 501 }, (_, index) => spotifyTarget({
    provider: "soundcloud",
    providerEntityId: `soundcloud:tracks:${index + 1}`,
    providerUriOrUrl: `soundcloud:tracks:${index + 1}`,
    redactedDisplayUrl: `soundcloud:tracks:${index + 1}`,
    attributionUrl: `https://soundcloud.com/example/track-${index + 1}`,
    isrc: undefined,
  }));
  assert.throws(() => createTransferBlueprint({
    transferId: "sc", destinationProvider: "soundcloud", mode: "MERGE_NEW",
    mergedMetadata: { title: "Large" }, sources: [source("s", targets)], settings: createTransferSettings(),
  }), /500-item limit/);

  const split = createTransferBlueprint({
    transferId: "sc", destinationProvider: "soundcloud", mode: "MERGE_NEW",
    mergedMetadata: { title: "Large" }, sources: [source("s", targets)],
    settings: createTransferSettings({ soundcloudOverflow: "SPLIT_WITH_CONFIRMATION" }),
  });
  assert.deepEqual(split.destinations.map((item) => item.items.length), [500, 1]);
  assert.match(split.destinations[1]?.metadata.title ?? "", /Part 2/);
});

test("quota helpers expose versioned breakdown and fail preflight on either bucket", () => {
  const estimate = estimateYoutubeTransferQuota(100, {
    destinationPlaylistCreates: 1,
    coverUploads: 1,
  });
  assert.equal(estimate.searchBucketCalls, 100);
  assert.equal(estimate.breakdown.inserts, 5_000);
  assert.equal(estimate.generalUnits, 5_104);
  assert.equal(assessYoutubeQuota(estimate, { searchCalls: 99, generalUnits: 10_000 }).canStartWithoutCreatingEmptyPlaylist, false);
  assert.equal(assessYoutubeQuota(estimate, { searchCalls: 100, generalUnits: 5_103 }).generalUnitsShortfall, 1);
  assert.equal(assessYoutubeQuota(estimate, { searchCalls: 100, generalUnits: 5_104 }).canStartWithoutCreatingEmptyPlaylist, true);
  assert.deepEqual([estimateSpotifyAppendRequests(201), estimateSoundcloudFullListWrite(501)], [3, { calls: 1, withinLimit: false }]);
});
