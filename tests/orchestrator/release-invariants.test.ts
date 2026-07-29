import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GuidedConnector } from "../../packages/connectors-core/src/guided-connector";
import type { Provider, ProviderEntityRef, ValidationResult } from "../../packages/connectors-core/src/types";
import type { YoutubeApiClient } from "../../packages/connectors/youtube/src/client";
import {
  createProviderVerifiedReceipt,
  type CandidateValidation,
  type ImmutableWritePlan,
  type ProviderTrackReference,
  type WriteReceipt,
} from "../../packages/domain/src/index";
import { TransferCoordinator } from "../../packages/orchestrator/src/coordinator";
import { LocalDatabase, type JsonObject, type TransferRecord } from "../../packages/storage-local/src/database";

const DESTINATION_ID = "PLreleaseInvariant01";
const DESTINATION_URL = `https://www.youtube.com/playlist?list=${DESTINATION_ID}`;
const CHECKED_AT = Date.parse("2026-07-29T18:00:00.000Z");

type CoordinatorView = ReturnType<TransferCoordinator["view"]>;

class OfflineConnector extends GuidedConnector {
  constructor(provider: Provider, private readonly providerValidated: boolean) {
    super(provider);
  }

  override async validateTargetEntity(ref: ProviderEntityRef): Promise<ValidationResult> {
    return {
      ref: {
        ...ref,
        titleRaw: "Release invariant target",
        artistRaw: "Fixture Artist",
        validationStatus: this.providerValidated ? "PROVIDER_VALIDATED" : "USER_SELECTED_UNVERIFIED",
        fetchedAt: CHECKED_AT,
      },
      evidence: {
        method: this.providerValidated ? "OFFICIAL_API" : "URL_SYNTAX",
        checkedAt: CHECKED_AT,
        providerReadBack: this.providerValidated,
        semanticEqualityProven: false,
      },
      limitations: this.providerValidated ? [] : ["OFFLINE_PROVIDER_READBACK_UNAVAILABLE"],
    };
  }
}

function database(prefix = "playlist-transfer-release-invariant-") {
  return new LocalDatabase(mkdtempSync(path.join(tmpdir(), prefix)));
}

function seedConnections(db: LocalDatabase): void {
  for (const provider of ["spotify", "youtube"] as const) {
    db.saveConnection({
      provider,
      accountId: `${provider}-fixture-account`,
      accountLabel: `${provider} release fixture`,
      strategy: "guided",
      status: "CONNECTED_LIMITED",
      scopes: [],
      capabilities: { domRead: false, uiWrite: false },
    });
  }
}

function seedSpotifySources(db: LocalDatabase, playlistCount: number, tracksPerPlaylist = 1): string[] {
  return Array.from({ length: playlistCount }, (_, playlistIndex) => {
    const providerPlaylistId = `${"S".repeat(21)}${playlistIndex}`;
    return db.savePlaylistSnapshot({
      provider: "spotify",
      providerPlaylistId,
      providerUrl: `https://open.spotify.com/playlist/${providerPlaylistId}`,
      title: `Release source ${playlistIndex + 1}`,
      description: `Synthetic source ${playlistIndex + 1}`,
      ownerLabel: "local fixture owner",
      eligibility: "USER_ATTESTED_OWNED",
      eligibilityEvidence: { method: "USER_ATTESTATION", fixture: true },
      partial: false,
      sourceVersion: `release-source-${playlistIndex + 1}`,
      snapshot: {
        tracks: Array.from({ length: tracksPerPlaylist }, (_, trackIndex) => {
          const suffix = String(playlistIndex * tracksPerPlaylist + trackIndex).padStart(2, "0");
          const providerEntityId = `${"T".repeat(20)}${suffix}`;
          const providerUrl = `https://open.spotify.com/track/${providerEntityId}`;
          return {
            position: trackIndex,
            titleRaw: `Release Signal ${suffix}`,
            artistRaw: "Fixture Artist",
            durationMs: 180_000 + trackIndex * 1_000,
            providerEntityId,
            providerUriOrUrl: providerUrl,
            attributionUrl: providerUrl,
          };
        }),
      },
    });
  });
}

function monotonicClock() {
  let now = Date.parse("2026-07-29T17:00:00.000Z");
  return () => new Date(now += 1_000);
}

function guidedCoordinator(db: LocalDatabase, now = monotonicClock()): TransferCoordinator {
  return new TransferCoordinator({
    database: db,
    now,
    guidedConnector: (provider) => new OfflineConnector(provider, false),
    youtubeClient: () => { throw new Error("YOUTUBE_API_NOT_CONFIGURED_OFFLINE"); },
  });
}

type FakeYoutubeControls = {
  readonly client: YoutubeApiClient;
  readonly appendCalls: string[];
  readonly verifyCalls: string[];
};

function fakeYoutubeClient(options: {
  appendError?: Error & { providerMutationMayHaveStarted?: boolean };
  initialVideoIds?: string[];
} = {}): FakeYoutubeControls {
  const appendCalls: string[] = [];
  const verifyCalls: string[] = [];
  const actualVideoIds = [...(options.initialVideoIds ?? [])];
  const client = {
    async validateTargetEntity(ref: ProviderEntityRef): Promise<ValidationResult> {
      return {
        ref: {
          ...ref,
          titleRaw: "Release invariant target",
          artistRaw: "Fixture Artist",
          durationMs: 180_000,
          embeddable: true,
          validationStatus: "PROVIDER_VALIDATED",
          fetchedAt: CHECKED_AT,
        },
        evidence: {
          method: "OFFICIAL_API",
          checkedAt: CHECKED_AT,
          providerReadBack: true,
          semanticEqualityProven: false,
        },
        limitations: [],
      };
    },
    async listEligiblePlaylists() {
      return [{
        id: DESTINATION_ID,
        title: "Release destination",
        description: "",
        itemCount: actualVideoIds.length,
        privacyStatus: "private",
        channelId: "fixture-channel",
        channelTitle: "Fixture channel",
        ownership: "API_OWNED" as const,
      }];
    },
    async searchCandidates() {
      return [];
    },
    async verifyPlaylist(playlistId: string) {
      verifyCalls.push(playlistId);
      return { verified: true, actualVideoIds: [...actualVideoIds], checkedAt: CHECKED_AT };
    },
    async appendItem(playlistId: string, videoId: string) {
      appendCalls.push(`${playlistId}:${videoId}`);
      if (options.appendError) throw options.appendError;
      actualVideoIds.push(videoId);
      return { playlistItemId: `playlist-item-${appendCalls.length}`, videoId };
    },
    async createPlaylist() {
      return { id: "PLcreatedRelease01", url: "https://www.youtube.com/playlist?list=PLcreatedRelease01" };
    },
  } as unknown as YoutubeApiClient;
  return { client, appendCalls, verifyCalls };
}

function apiCoordinator(db: LocalDatabase, youtube: YoutubeApiClient, now = monotonicClock()): TransferCoordinator {
  return new TransferCoordinator({
    database: db,
    now,
    allowPolicyGatedAutoMatchingForTests: true,
    guidedConnector: (provider) => new OfflineConnector(provider, true),
    youtubeClient: () => youtube,
  });
}

function createAppend(app: TransferCoordinator, sourceId: string): TransferRecord {
  return app.create({
    sourceProvider: "spotify",
    destinationProvider: "youtube",
    mode: "APPEND_EXISTING",
    selectedPlaylistIds: [sourceId],
    destination: {
      title: "Release destination",
      playlistUrl: DESTINATION_URL,
      ownershipAttested: true,
      editControlAttested: true,
      existingItemIds: [],
      existingItemCount: 0,
    },
  });
}

test("provider-owned YouTube preflight replaces the provisional partial destination status", async () => {
  const db = database();
  seedConnections(db);
  const [sourceId] = seedSpotifySources(db, 1);
  const youtube = fakeYoutubeClient({ initialVideoIds: ["existing001"] }).client;
  const app = apiCoordinator(db, youtube);
  const transfer = app.create({
    sourceProvider: "spotify",
    destinationProvider: "youtube",
    mode: "APPEND_EXISTING",
    selectedPlaylistIds: [sourceId],
    destination: {
      title: "Release destination",
      playlistUrl: DESTINATION_URL,
      ownershipAttested: true,
      editControlAttested: true,
      existingItemIds: [],
      existingItemCount: 1,
    },
  });
  assert.ok(transfer.limitationCodes.includes("DESTINATION_CONTENT_IDS_PARTIAL_USER_ATTESTED"));
  await app.start(transfer.id);
  const view = app.view(transfer.id);
  assert.equal((view.transfer.destination as { eligibility?: string }).eligibility, "PROVIDER_VERIFIED_OWNED");
  assert.equal(view.transfer.limitationCodes.includes("DESTINATION_CONTENT_IDS_PARTIAL_USER_ATTESTED"), false);
  db.destroyFiles();
});

test("release default never calls cross-provider YouTube search behind the policy gate", async () => {
  const db = database();
  seedConnections(db);
  const [sourceId] = seedSpotifySources(db, 1);
  let searchCalls = 0;
  const youtube = fakeYoutubeClient().client;
  youtube.searchCandidates = async () => { searchCalls += 1; return []; };
  const app = new TransferCoordinator({
    database: db,
    now: monotonicClock(),
    guidedConnector: (provider) => new OfflineConnector(provider, false),
    youtubeClient: () => youtube,
  });
  const transfer = createAppend(app, sourceId!);
  const view = await app.start(transfer.id) as CoordinatorView;
  assert.equal(searchCalls, 0);
  assert.equal(view.transfer.state, "NEEDS_REVIEW");
  assert.equal(view.items[0]?.state, "NEEDS_REVIEW");
  assert.ok(view.transfer.limitationCodes.includes("CROSS_PROVIDER_DERIVED_MATCHING_POLICY_GATE"));
  db.close();
});

async function selectAllYoutubeTargets(app: TransferCoordinator, transferId: string): Promise<CoordinatorView> {
  let view = await app.start(transferId) as CoordinatorView;
  const reviewItems = view.items.filter((item) => item.state === "NEEDS_REVIEW");
  for (const [index, item] of reviewItems.entries()) {
    const videoId = `relvideo${String(index).padStart(3, "0")}`;
    assert.equal(videoId.length, 11);
    view = await app.review(transferId, {
      action: "select",
      itemId: item.id,
      target: `https://www.youtube.com/watch?v=${videoId}`,
    }) as CoordinatorView;
  }
  return view;
}

function selectedItemAndPlan(db: LocalDatabase, transferId: string) {
  const transfer = db.getTransfer(transferId)!;
  const item = db.listTransferItems(transferId)[0]!;
  const selected = item.selectedTarget as {
    target: ProviderTrackReference;
    validation: CandidateValidation;
    writeStrategy: "API" | "GUIDED_USER_ACTION";
  };
  const plan = transfer.writePlan as unknown as ImmutableWritePlan;
  const planned = plan.destinations.flatMap((destination) => destination.items)
    .find((candidate) => candidate.sourceItemId === item.id)!;
  return { transfer, item, selected, plan, planned };
}

function persistDomainReceipt(db: LocalDatabase, transferId: string): WriteReceipt {
  const { item, selected, planned } = selectedItemAndPlan(db, transferId);
  assert.equal(selected.validation.status, "PROVIDER_VALIDATED");
  const writtenAt = "2026-07-29T17:30:00.000Z";
  const receipt = createProviderVerifiedReceipt({
    receiptId: randomUUID(),
    transferId,
    destinationPlaylistId: planned.destinationPlaylistId,
    target: selected.target,
    idempotencyKey: planned.idempotencyKey,
    writtenAt,
  }, selected.validation, {
    kind: "API_READ_AFTER_WRITE",
    provider: "youtube",
    destinationPlaylistId: planned.destinationPlaylistId,
    checkedAt: "2026-07-29T17:31:00.000Z",
    observedProviderEntityIds: [selected.target.providerEntityId],
    evidenceVersion: "release-recovery-fixture-v1",
  });
  db.saveReceipt({
    id: receipt.receiptId,
    transferId,
    transferItemId: String(item.id),
    destinationPlaylistId: receipt.destinationPlaylistId,
    targetEntityId: receipt.target.providerEntityId,
    idempotencyKey: receipt.idempotencyKey,
    executionStatus: "WRITTEN",
    verificationStatus: receipt.verificationStatus,
    evidence: { domainReceipt: receipt } as unknown as JsonObject,
    risky: false,
    manual: false,
  });
  return receipt;
}

test("SEPARATE_COPY rejects reusing one real destination ID for two source playlists", async (t) => {
  const db = database();
  t.after(() => db.destroyFiles());
  seedConnections(db);
  const sourceIds = seedSpotifySources(db, 2);
  const app = guidedCoordinator(db);
  const transfer = app.create({
    sourceProvider: "spotify",
    destinationProvider: "youtube",
    mode: "SEPARATE_COPY",
    selectedPlaylistIds: sourceIds,
    destination: { title: "Separate copies" },
  });

  let view = await selectAllYoutubeTargets(app, transfer.id);
  assert.equal(view.transfer.state, "NEEDS_REVIEW");
  assert.equal(view.bindingNeeds.length, 2);
  const [first, second] = view.bindingNeeds;
  assert.ok(first && second);

  view = await app.bindDestination(transfer.id, {
    planKey: first.planKey,
    playlistUrl: "https://www.youtube.com/playlist?list=PLseparateRelease01",
    ownershipAttested: true,
    editControlAttested: true,
    newPlaylistAttested: true,
    visibleItemCount: 0,
  }) as CoordinatorView;
  assert.equal(view.bindingNeeds.length, 1);
  await assert.rejects(
    app.bindDestination(transfer.id, {
      planKey: second.planKey,
      playlistUrl: "https://www.youtube.com/playlist?list=PLseparateRelease01",
      ownershipAttested: true,
      editControlAttested: true,
      newPlaylistAttested: true,
      visibleItemCount: 0,
    }),
    /SEPARATE_COPY_DESTINATION_MUST_BE_UNIQUE_PER_SOURCE/,
  );

  view = await app.bindDestination(transfer.id, {
    planKey: second.planKey,
    playlistUrl: "https://www.youtube.com/playlist?list=PLseparateRelease02",
    ownershipAttested: true,
    editControlAttested: true,
    newPlaylistAttested: true,
    visibleItemCount: 0,
  }) as CoordinatorView;
  const destinationIds = (view.transfer.writePlan as unknown as ImmutableWritePlan).destinations
    .map((destination) => destination.destinationPlaylistId);
  assert.equal(view.transfer.state, "READY_TO_WRITE");
  assert.equal(new Set(destinationIds).size, 2);
});

test("MERGE_NEW accepts only an explicitly attested newly created empty destination", async (t) => {
  const db = database();
  t.after(() => db.destroyFiles());
  seedConnections(db);
  const [sourceId] = seedSpotifySources(db, 1, 2);
  const app = guidedCoordinator(db);
  const transfer = app.create({
    sourceProvider: "spotify",
    destinationProvider: "youtube",
    mode: "MERGE_NEW",
    selectedPlaylistIds: [sourceId!],
    destination: { title: "New merged destination" },
  });

  let view = await selectAllYoutubeTargets(app, transfer.id);
  const planKey = view.bindingNeeds[0]?.planKey;
  assert.ok(planKey);
  const binding = {
    planKey,
    playlistUrl: "https://www.youtube.com/playlist?list=PLmergeReleaseNew01",
    ownershipAttested: true,
    editControlAttested: true,
  };
  await assert.rejects(
    app.bindDestination(transfer.id, { ...binding, newPlaylistAttested: false, visibleItemCount: 0 }),
    /NEW_DESTINATION_CREATION_ATTESTATION_REQUIRED/,
  );
  await assert.rejects(
    app.bindDestination(transfer.id, { ...binding, newPlaylistAttested: true, visibleItemCount: 1 }),
    /NEW_DESTINATION_MUST_BE_EMPTY_AT_BINDING/,
  );

  view = await app.bindDestination(transfer.id, {
    ...binding,
    newPlaylistAttested: true,
    visibleItemCount: 0,
  }) as CoordinatorView;
  assert.equal(view.transfer.state, "READY_TO_WRITE");
  assert.equal(view.transfer.destination.bindings[planKey]?.newPlaylistAttested, true);
  assert.equal(view.transfer.destination.bindings[planKey]?.initialVisibleItemCount, 0);

  view = await app.runNext(transfer.id) as CoordinatorView;
  assert.equal(view.pendingAction?.requiresFreshDestinationConfirmation, true);
  assert.equal(view.pendingAction?.destinationBaselineKind, "NEW_EMPTY_AT_BINDING");
  assert.equal(view.pendingAction?.expectedDestinationItemCount, 0);
  assert.equal(view.pendingAction?.confirmedPriorAdds, 0);
  await app.reconcile(transfer.id, { itemId: view.items[0]!.id, result: "present" });

  view = await app.runNext(transfer.id) as CoordinatorView;
  assert.equal(view.pendingAction?.expectedDestinationItemCount, 1);
  assert.equal(view.pendingAction?.confirmedPriorAdds, 1);
});

test("a pre-mutation API quota failure flips the whole job to guided mode", async (t) => {
  const db = database();
  t.after(() => db.destroyFiles());
  seedConnections(db);
  const [sourceId] = seedSpotifySources(db, 1, 2);
  const quotaError = Object.assign(new Error("YOUTUBE_GENERAL_QUOTA_WAIT"), { providerMutationMayHaveStarted: false });
  const youtube = fakeYoutubeClient({ appendError: quotaError });
  const app = apiCoordinator(db, youtube.client);
  const transfer = createAppend(app, sourceId!);

  let view = await selectAllYoutubeTargets(app, transfer.id);
  assert.equal(view.transfer.state, "READY_TO_WRITE");
  assert.deepEqual(view.items.map((item) => item.selection?.writeStrategy), ["API", "API"]);

  view = await app.runNext(transfer.id) as CoordinatorView;
  assert.equal(view.transfer.state, "WRITING");
  assert.equal(view.transfer.destination.forceGuided, true);
  assert.equal(view.items[0]?.state, "AWAITING_USER_RECONCILIATION");
  assert.equal(view.items[0]?.selection?.writeStrategy, "GUIDED_USER_ACTION");
  assert.equal(view.pendingAction?.requiresFreshDestinationConfirmation, true);
  assert.equal(view.pendingAction?.destinationBaselineKind, "EXISTING_SNAPSHOT");
  assert.equal(view.pendingAction?.expectedDestinationItemCount, 0);
  assert.equal(youtube.appendCalls.length, 1);
  assert.equal(db.listJournal(transfer.id).find((entry) => entry.stepKey === `api:${view.items[0]!.id}`)?.status, "FAILED_BEFORE_MUTATION");

  view = await app.reconcile(transfer.id, { itemId: view.items[0]!.id, result: "present" }) as CoordinatorView;
  view = await app.runNext(transfer.id) as CoordinatorView;
  assert.equal(view.items[1]?.state, "AWAITING_USER_RECONCILIATION");
  assert.equal(view.pendingAction?.expectedDestinationItemCount, 1);
  assert.equal(view.pendingAction?.confirmedPriorAdds, 1);
  assert.equal(youtube.appendCalls.length, 1, "later items must not re-enter API writes after job-level fallback");
});

test("restart recovers a persisted receipt through WRITE_PENDING -> WRITTEN -> terminal", async (t) => {
  const db = database();
  t.after(() => db.destroyFiles());
  seedConnections(db);
  const [sourceId] = seedSpotifySources(db, 1);
  const youtube = fakeYoutubeClient();
  const clock = monotonicClock();
  const app = apiCoordinator(db, youtube.client, clock);
  const transfer = createAppend(app, sourceId!);
  const ready = await selectAllYoutubeTargets(app, transfer.id);
  assert.equal(ready.transfer.state, "READY_TO_WRITE");
  assert.equal(ready.items[0]?.state, "WRITE_PENDING");
  persistDomainReceipt(db, transfer.id);

  const recoveredStates: string[] = [];
  const originalSaveItem = db.saveTransferItem.bind(db);
  db.saveTransferItem = (item) => {
    if (item.transferId === transfer.id) recoveredStates.push(item.state);
    return originalSaveItem(item);
  };
  const restarted = apiCoordinator(db, youtube.client, clock);
  const view = await restarted.runNext(transfer.id) as CoordinatorView;

  assert.deepEqual(recoveredStates, ["WRITTEN", "VERIFIED_PROVIDER"]);
  assert.equal(view.items[0]?.state, "VERIFIED_PROVIDER");
  assert.equal(view.transfer.state, "COMPLETED");
  assert.equal(view.report.counts.VERIFIED_PROVIDER, 1);
  assert.equal(youtube.appendCalls.length, 0, "receipt recovery must suppress a duplicate provider append");
});

test("cancelling an awaiting guided write is PARTIAL, unverified, and closes its journal", async (t) => {
  const db = database();
  t.after(() => db.destroyFiles());
  seedConnections(db);
  const [sourceId] = seedSpotifySources(db, 1);
  const app = guidedCoordinator(db);
  const transfer = createAppend(app, sourceId!);
  await selectAllYoutubeTargets(app, transfer.id);
  let view = await app.runNext(transfer.id) as CoordinatorView;
  const itemId = view.items[0]!.id;
  assert.equal(view.items[0]?.state, "AWAITING_USER_RECONCILIATION");

  view = await app.cancel(transfer.id) as CoordinatorView;
  assert.equal(view.transfer.state, "PARTIAL");
  assert.equal(view.items[0]?.state, "WRITE_UNVERIFIED");
  assert.equal(view.receipts.length, 1);
  assert.equal(view.receipts[0]?.verificationStatus, "WRITE_UNVERIFIED");
  assert.equal(db.listJournal(transfer.id).find((entry) => entry.stepKey === `guided:${itemId}`)?.status, "CANCELLED_WITH_POSSIBLE_PROVIDER_MUTATION");
  assert.ok(view.transfer.limitationCodes.includes("CANCELLED_WITH_POSSIBLE_UNVERIFIED_PROVIDER_MUTATION"));
});

test("restart cancellation treats a durable API_ADD/RUNNING marker as a possible write", async (t) => {
  const db = database();
  t.after(() => db.destroyFiles());
  seedConnections(db);
  const [sourceId] = seedSpotifySources(db, 1);
  const youtube = fakeYoutubeClient();
  const clock = monotonicClock();
  const app = apiCoordinator(db, youtube.client, clock);
  const transfer = createAppend(app, sourceId!);
  await selectAllYoutubeTargets(app, transfer.id);
  const { transfer: ready, item, planned } = selectedItemAndPlan(db, transfer.id);
  db.saveTransfer({ ...ready, state: "WRITING", updatedAtMs: ready.updatedAtMs + 1 });
  db.appendJournal({
    transferId: transfer.id,
    sequence: 500,
    stepKind: "API_ADD",
    stepKey: `api:${item.id}`,
    status: "RUNNING",
    payload: {
      issuedAt: "2026-07-29T17:30:00.000Z",
      destinationPlaylistId: planned.destinationPlaylistId,
      targetEntityId: planned.target.providerEntityId,
      beforeTargetCount: 0,
      idempotencyKey: planned.idempotencyKey,
      providerMutationMayHaveStarted: true,
    },
  });

  const restarted = apiCoordinator(db, youtube.client, clock);
  const view = await restarted.cancel(transfer.id) as CoordinatorView;
  assert.equal(view.transfer.state, "PARTIAL");
  assert.equal(view.items[0]?.state, "WRITE_UNVERIFIED");
  assert.equal(view.receipts[0]?.verificationStatus, "WRITE_UNVERIFIED");
  assert.equal(db.listJournal(transfer.id).find((entry) => entry.stepKey === `api:${item.id}`)?.status, "CANCELLED_WITH_POSSIBLE_PROVIDER_MUTATION");
  assert.equal(youtube.appendCalls.length, 0);
});

for (const release of ["reconcile", "cancel"] as const) {
  test(`destination reservation blocks a second transfer until ${release}`, async (t) => {
    const db = database(`playlist-transfer-destination-${release}-`);
    t.after(() => db.destroyFiles());
    seedConnections(db);
    const [firstSource, secondSource] = seedSpotifySources(db, 2);
    const app = guidedCoordinator(db);
    const first = createAppend(app, firstSource!);
    const second = createAppend(app, secondSource!);
    await selectAllYoutubeTargets(app, first.id);
    await selectAllYoutubeTargets(app, second.id);

    const waiting = await app.runNext(first.id) as CoordinatorView;
    assert.equal(waiting.items[0]?.state, "AWAITING_USER_RECONCILIATION");
    await assert.rejects(app.runNext(second.id), /DESTINATION_BUSY/);

    if (release === "reconcile") {
      await app.reconcile(first.id, { itemId: waiting.items[0]!.id, result: "present" });
    } else {
      await app.cancel(first.id);
    }
    const unblocked = await app.runNext(second.id) as CoordinatorView;
    assert.equal(unblocked.items[0]?.state, "AWAITING_USER_RECONCILIATION");
    await app.cancel(second.id);
  });
}

test("restart repairs a historic plan + NEEDS_REVIEW half-state before writing", async (t) => {
  const db = database();
  t.after(() => db.destroyFiles());
  seedConnections(db);
  const [sourceId] = seedSpotifySources(db, 1);
  const clock = monotonicClock();
  const app = guidedCoordinator(db, clock);
  const transfer = createAppend(app, sourceId!);
  const ready = await selectAllYoutubeTargets(app, transfer.id);
  assert.equal(ready.transfer.state, "READY_TO_WRITE");
  assert.ok(ready.transfer.writePlan);
  const stored = db.getTransfer(transfer.id)!;
  db.saveTransfer({ ...stored, state: "NEEDS_REVIEW", updatedAtMs: stored.updatedAtMs + 1 });

  const restarted = guidedCoordinator(db, clock);
  const repaired = await restarted.runNext(transfer.id) as CoordinatorView;
  assert.equal(repaired.transfer.state, "WRITING");
  assert.equal(repaired.items[0]?.state, "AWAITING_USER_RECONCILIATION");
  assert.equal(db.listJournal(transfer.id).filter((entry) => entry.stepKey === `guided:${repaired.items[0]!.id}`).length, 1);

  const resumed = guidedCoordinator(db, clock).view(transfer.id);
  assert.equal(resumed.pendingAction?.id, repaired.pendingAction?.id, "restart must preserve the same durable action card");
});
