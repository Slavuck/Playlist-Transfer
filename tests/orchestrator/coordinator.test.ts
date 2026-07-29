import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalDatabase } from "../../packages/storage-local/src/database";
import { TransferCoordinator } from "../../packages/orchestrator/src/coordinator";
import { buildSearchUrl, parseProviderUrl } from "../../packages/connectors-core/src/url-policy";
import type { Provider, ProviderConnector } from "../../packages/connectors-core/src/types";
import type { YoutubeApiClient } from "../../packages/connectors/youtube/src/client";

function database() {
  return new LocalDatabase(mkdtempSync(path.join(tmpdir(), "playlist-transfer-orchestrator-")));
}

function guided(provider: Provider): ProviderConnector {
  return {
    provider,
    strategy: "guided",
    capabilities: {
      canReadOwned: true,
      canReadCollaborative: "unknown",
      canWriteOwned: true,
      canWriteCollaborative: "unknown",
      canCreate: true,
      canBatchAdd: false,
      batchSize: 1,
      canPreserveOrder: true,
      canSetCoverOnCreate: false,
      canSetCoverAfterCreate: false,
      canSeekToFraction: provider === "youtube",
      canEmbedAlongsideCompetitor: false,
      supportsISRC: false,
      requiresWriteReauth: false,
      domRead: false,
      uiWrite: false,
    },
    parseUserUrl: (url) => parseProviderUrl(provider, url),
    buildSearchUrl: (query) => buildSearchUrl(provider, query),
    validateTargetEntity: async (ref) => ({
      ref: { ...ref, validationStatus: "USER_SELECTED_UNVERIFIED" },
      evidence: { method: "URL_SYNTAX", checkedAt: Date.now(), providerReadBack: false, semanticEqualityProven: false },
      limitations: ["PROVIDER_READBACK_UNAVAILABLE"],
    }),
    buildAddAction: (ref, destination) => ({
      id: `action-${ref.providerEntityId}`,
      provider,
      kind: "ADD_ITEM",
      title: `Add to ${destination.label}`,
      instructions: ["Open official UI", "Add exact target", "Return and reconcile"],
      openUrl: ref.redactedDisplayUrl,
      targetEntityId: ref.videoId ?? ref.providerEntityId,
      destinationLabel: destination.label,
      expectedManualActions: 3,
      automation: "USER_OPERATED",
    }),
  };
}

function seedSpotify(db: LocalDatabase) {
  for (const provider of ["spotify", "youtube"] as const) {
    db.saveConnection({
      provider,
      accountLabel: `${provider}-fixture`,
      strategy: "guided",
      status: "CONNECTED_LIMITED",
      scopes: [],
      capabilities: { domRead: false, uiWrite: false },
    });
  }
  return db.savePlaylistSnapshot({
    provider: "spotify",
    providerPlaylistId: "P".repeat(22),
    providerUrl: `https://open.spotify.com/playlist/${"P".repeat(22)}`,
    title: "Owned source",
    ownerLabel: "local-user",
    eligibility: "USER_ATTESTED_OWNED",
    eligibilityEvidence: { method: "USER_ATTESTATION" },
    partial: false,
    sourceVersion: "fixture-v1",
    snapshot: {
      tracks: [{
        position: 0,
        titleRaw: "Signal Fire",
        artistRaw: "Local Artist",
        durationMs: 180_000,
        providerEntityId: "T".repeat(22),
        providerUriOrUrl: `https://open.spotify.com/track/${"T".repeat(22)}`,
        attributionUrl: `https://open.spotify.com/track/${"T".repeat(22)}`,
      }],
    },
  });
}

function coordinator(db: LocalDatabase) {
  return new TransferCoordinator({
    allowPolicyGatedAutoMatchingForTests: true,
    database: db,
    guidedConnector: guided,
    youtubeClient: () => { throw new Error("YOUTUBE_API_NOT_CONNECTED"); },
  });
}

test("guided transfer persists one action and reports manual assurance separately", async () => {
  const db = database();
  const sourceId = seedSpotify(db);
  const app = coordinator(db);
  const transfer = app.create({
    sourceProvider: "spotify",
    destinationProvider: "youtube",
    mode: "APPEND_EXISTING",
    selectedPlaylistIds: [sourceId],
    destination: {
      title: "Owned target",
      playlistUrl: "https://www.youtube.com/playlist?list=PLabcdefghijk",
      ownershipAttested: true,
      editControlAttested: true,
    },
  });

  let view = await app.start(transfer.id) as ReturnType<TransferCoordinator["view"]>;
  assert.equal(view.transfer.state, "NEEDS_REVIEW");
  assert.equal(view.items[0]?.state, "NEEDS_REVIEW");

  view = await app.review(transfer.id, { action: "select", itemId: view.items[0]!.id, target: "https://www.youtube.com/watch?v=abcdefghijk" }) as ReturnType<TransferCoordinator["view"]>;
  assert.equal(view.transfer.state, "READY_TO_WRITE");
  assert.equal(view.items[0]?.candidates[0]?.validation.status, "USER_SELECTED_UNVERIFIED");
  assert.equal(view.items[0]?.candidates[0]?.provenance.source, "URL_SYNTAX_ONLY");
  assert.equal(view.items[0]?.candidates[0]?.provenance.providerExistenceConfirmed, false);
  assert.equal(view.items[0]?.candidates[0]?.provenance.metadataFields.length, 0);
  assert.equal(view.items[0]?.candidates[0]?.target.titleRaw, "URL-only target abcdefghijk");
  assert.equal(view.items[0]?.candidates[0]?.target.availability, "UNKNOWN");
  assert.notEqual(view.items[0]?.candidates[0]?.target.titleRaw, "Signal Fire", "URL syntax must never borrow source metadata");

  view = await app.runNext(transfer.id) as ReturnType<TransferCoordinator["view"]>;
  assert.equal(view.transfer.state, "WRITING");
  assert.equal(view.items[0]?.state, "AWAITING_USER_RECONCILIATION");
  assert.equal(view.pendingAction?.automation, "USER_OPERATED");

  const restarted = coordinator(db);
  const resumed = restarted.view(transfer.id);
  assert.deepEqual(resumed.pendingAction, view.pendingAction, "restart must not issue a second action card");

  view = await restarted.reconcile(transfer.id, { itemId: view.items[0]!.id, result: "present" }) as ReturnType<TransferCoordinator["view"]>;
  assert.equal(view.transfer.state, "COMPLETED");
  assert.equal(view.report.counts.USER_CONFIRMED_MANUAL, 1);
  assert.equal(view.report.counts.VERIFIED_PROVIDER, 0);
  assert.equal(view.report.independentlyVerified, 0);
  db.destroyFiles();
});

test("configured YouTube exact-ID read-back keeps provider metadata and iframe facts", async () => {
  const db = database();
  const sourceId = seedSpotify(db);
  let validationCalls = 0;
  const youtube = {
    async validateTargetEntity(ref: ReturnType<typeof parseProviderUrl>) {
      validationCalls += 1;
      return {
        ref: {
          ...ref,
          titleRaw: "Official target title",
          artistRaw: "Official channel",
          durationMs: 200_000,
          embeddable: true,
          validationStatus: "PROVIDER_VALIDATED" as const,
          fetchedAt: Date.parse("2026-07-29T19:00:00.000Z"),
        },
        evidence: {
          method: "OFFICIAL_API" as const,
          checkedAt: Date.parse("2026-07-29T19:00:00.000Z"),
          providerReadBack: true,
          semanticEqualityProven: false as const,
        },
        limitations: ["SEMANTIC_EQUALITY_NOT_PROVEN"],
      };
    },
  } as unknown as YoutubeApiClient;
  const app = new TransferCoordinator({
    database: db,
    guidedConnector: guided,
    youtubeClient: () => youtube,
  });
  const transfer = app.create({
    sourceProvider: "spotify",
    destinationProvider: "youtube",
    mode: "APPEND_EXISTING",
    selectedPlaylistIds: [sourceId],
    destination: {
      title: "Owned target",
      playlistUrl: "https://www.youtube.com/playlist?list=PLabcdefghijk",
      ownershipAttested: true,
      editControlAttested: true,
    },
  });

  let view = await app.start(transfer.id) as ReturnType<TransferCoordinator["view"]>;
  assert.equal(view.transfer.state, "NEEDS_REVIEW");
  view = await app.review(transfer.id, {
    action: "select",
    itemId: view.items[0]!.id,
    target: "https://www.youtube.com/watch?v=abcdefghijk",
  }) as ReturnType<TransferCoordinator["view"]>;

  const candidate = view.items[0]?.candidates[0];
  assert.equal(validationCalls, 1);
  assert.equal(candidate?.validation.status, "PROVIDER_VALIDATED");
  assert.equal(candidate?.provenance.source, "PROVIDER_API");
  assert.equal(candidate?.provenance.providerExistenceConfirmed, true);
  assert.deepEqual(candidate?.provenance.metadataFields, ["title", "artist", "duration", "embeddable"]);
  assert.equal(candidate?.target.titleRaw, "Official target title");
  assert.equal(candidate?.target.durationMs, 200_000);
  assert.equal(candidate?.target.embeddable, true);
  assert.equal(candidate?.target.availability, "AVAILABLE");
  assert.equal(candidate?.embeddable, true);
  db.destroyFiles();
});

test("unknown guided result is unverified and never counted as success", async () => {
  const db = database();
  const sourceId = seedSpotify(db);
  const app = coordinator(db);
  const transfer = app.create({
    sourceProvider: "spotify",
    destinationProvider: "youtube",
    mode: "APPEND_EXISTING",
    selectedPlaylistIds: [sourceId],
    destination: { title: "Target", providerPlaylistId: "PLabcdefghijk", ownershipAttested: true, editControlAttested: true },
  });
  let view = await app.start(transfer.id) as ReturnType<TransferCoordinator["view"]>;
  view = await app.review(transfer.id, { action: "select", itemId: view.items[0]!.id, target: "https://www.youtube.com/watch?v=abcdefghijk" }) as ReturnType<TransferCoordinator["view"]>;
  view = await app.runNext(transfer.id) as ReturnType<TransferCoordinator["view"]>;
  view = await app.reconcile(transfer.id, { itemId: view.items[0]!.id, result: "unknown" }) as ReturnType<TransferCoordinator["view"]>;
  assert.equal(view.transfer.state, "PARTIAL");
  assert.equal(view.report.counts.UNVERIFIED, 1);
  assert.equal(view.report.successful, 0);
  db.destroyFiles();
});

test("explicit absent reconciliation is the only path that permits another guided card", async () => {
  const db = database();
  const sourceId = seedSpotify(db);
  const app = coordinator(db);
  const transfer = app.create({
    sourceProvider: "spotify",
    destinationProvider: "youtube",
    mode: "APPEND_EXISTING",
    selectedPlaylistIds: [sourceId],
    destination: { title: "Target", providerPlaylistId: "PLabcdefghijk", ownershipAttested: true, editControlAttested: true },
  });
  let view = await app.start(transfer.id) as ReturnType<TransferCoordinator["view"]>;
  const itemId = view.items[0]!.id;
  await app.review(transfer.id, { action: "select", itemId, target: "https://www.youtube.com/watch?v=abcdefghijk" });
  view = await app.runNext(transfer.id) as ReturnType<TransferCoordinator["view"]>;
  await app.reconcile(transfer.id, { itemId, result: "absent" });
  assert.equal(app.view(transfer.id).items[0]?.state, "WRITE_PENDING");
  view = await app.runNext(transfer.id) as ReturnType<TransferCoordinator["view"]>;
  assert.equal(view.items[0]?.state, "AWAITING_USER_RECONCILIATION");
  assert.equal(db.listReceipts(transfer.id).length, 0);
  db.destroyFiles();
});
