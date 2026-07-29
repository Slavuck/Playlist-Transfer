import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GuidedConnector } from "../connectors-core/src/guided-connector.js";
import type {
  Provider,
  ProviderEntityRef,
  ValidationResult,
} from "../connectors-core/src/types.js";
import type { TransferMode } from "../domain/src/index.js";
import { TransferCoordinator } from "../orchestrator/src/coordinator.js";
import {
  LocalDatabase,
  type JsonObject,
} from "../storage-local/src/database.js";
import type { ProviderDirection } from "./gold-dataset.js";

/**
 * Keeps coordinator integration tests offline while retaining the production
 * GuidedConnector URL parser, capabilities and action-card implementation.
 */
class OfflineGuidedConnector extends GuidedConnector {
  override async validateTargetEntity(ref: ProviderEntityRef): Promise<ValidationResult> {
    if (ref.provider !== this.provider) throw new Error("PROVIDER_MISMATCH");
    return {
      ref: { ...ref, validationStatus: "USER_SELECTED_UNVERIFIED" },
      evidence: {
        method: "URL_SYNTAX",
        checkedAt: Date.parse("2026-07-29T14:01:00.000Z"),
        providerReadBack: false,
        semanticEqualityProven: false,
      },
      limitations: ["OFFLINE_FIXTURE_PROVIDER_READBACK_UNAVAILABLE"],
    };
  }
}

export interface CoordinatorMatrixCase {
  readonly direction: ProviderDirection;
  readonly mode: TransferMode;
  readonly riskMode: "SAFE" | "RISKY";
  readonly reviewUncertain: boolean;
}

export interface CoordinatorHarness {
  readonly database: LocalDatabase;
  readonly sourceSnapshotId: string;
  readonly targetTrackUrl: string;
  readonly destinationPlaylistUrl: string;
  readonly counters: {
    connectorFactoryCalls: number;
    youtubeClientCalls: number;
  };
  coordinator(): TransferCoordinator;
  dispose(): void;
}

function sourcePlaylistId(provider: Provider): string {
  if (provider === "spotify") return "S".repeat(22);
  if (provider === "youtube") return "PLsourceSynthetic001";
  return "soundcloud:playlists:900001";
}

function sourcePlaylistUrl(provider: Provider): string {
  if (provider === "spotify") return `https://open.spotify.com/playlist/${sourcePlaylistId(provider)}`;
  if (provider === "youtube") return `https://www.youtube.com/playlist?list=${sourcePlaylistId(provider)}`;
  return "https://soundcloud.com/synthetic-owner/sets/source-list";
}

function sourceTrack(provider: Provider): JsonObject {
  if (provider === "spotify") {
    const id = "A".repeat(22);
    const url = `https://open.spotify.com/track/${id}`;
    return {
      position: 0,
      titleRaw: "Coordinator Signal",
      artistRaw: "Synthetic Fixture Artist",
      durationMs: 201_000,
      providerEntityId: id,
      providerUriOrUrl: url,
      attributionUrl: url,
    };
  }
  if (provider === "youtube") {
    const id = "SrcVideo001";
    const url = `https://www.youtube.com/watch?v=${id}`;
    return {
      position: 0,
      titleRaw: "Coordinator Signal",
      artistRaw: "Synthetic Fixture Artist",
      durationMs: 201_000,
      providerEntityId: id,
      videoId: id,
      providerUriOrUrl: url,
      attributionUrl: url,
    };
  }
  const url = "https://soundcloud.com/synthetic-owner/coordinator-signal";
  return {
    position: 0,
    titleRaw: "Coordinator Signal",
    artistRaw: "Synthetic Fixture Artist",
    durationMs: 201_000,
    providerEntityId: url,
    providerUriOrUrl: url,
    attributionUrl: url,
  };
}

export function destinationTrackUrl(provider: Provider): string {
  if (provider === "spotify") return `https://open.spotify.com/track/${"T".repeat(22)}`;
  if (provider === "youtube") return "https://www.youtube.com/watch?v=abcdefghijk";
  return "https://soundcloud.com/synthetic-owner/target-signal";
}

export function destinationPlaylistUrl(provider: Provider): string {
  if (provider === "spotify") return `https://open.spotify.com/playlist/${"D".repeat(22)}`;
  if (provider === "youtube") return "https://www.youtube.com/playlist?list=PLabcdefghijk";
  return "https://soundcloud.com/synthetic-owner/sets/target-list";
}

function seedConnections(database: LocalDatabase): void {
  for (const provider of ["spotify", "soundcloud", "youtube"] as const) {
    const connector = new OfflineGuidedConnector(provider);
    database.saveConnection({
      provider,
      accountId: `fixture-${provider}`,
      accountLabel: `${provider} offline fixture`,
      profileUrl: provider === "spotify"
        ? "https://open.spotify.com/"
        : provider === "youtube"
          ? "https://www.youtube.com/"
          : "https://soundcloud.com/synthetic-owner",
      strategy: "guided",
      status: "CONNECTED_LIMITED",
      scopes: [],
      capabilities: connector.capabilities as unknown as JsonObject,
      authorizedAtMs: Date.parse("2026-07-29T14:00:00.000Z"),
    });
  }
}

function monotonicClock(): () => Date {
  let value = Date.parse("2026-07-29T14:00:00.000Z");
  return () => new Date(value += 1_000);
}

export function createCoordinatorHarness(direction: ProviderDirection): CoordinatorHarness {
  const directory = mkdtempSync(path.join(tmpdir(), "playlist-transfer-coordinator-matrix-"));
  const database = new LocalDatabase(directory);
  seedConnections(database);
  const sourceSnapshotId = database.savePlaylistSnapshot({
    provider: direction[0],
    providerPlaylistId: sourcePlaylistId(direction[0]),
    providerUrl: sourcePlaylistUrl(direction[0]),
    title: `${direction[0]} owned synthetic source`,
    ownerLabel: `fixture-${direction[0]}`,
    eligibility: "USER_ATTESTED_OWNED",
    eligibilityEvidence: {
      method: "USER_ATTESTATION",
      ownerControlConfirmed: true,
      fixture: true,
    },
    partial: false,
    sourceVersion: "coordinator-matrix-v1",
    snapshot: { tracks: [sourceTrack(direction[0])] },
  });
  const counters = { connectorFactoryCalls: 0, youtubeClientCalls: 0 };
  const now = monotonicClock();
  const coordinator = () => new TransferCoordinator({
    allowPolicyGatedAutoMatchingForTests: true,
    database,
    now,
    guidedConnector: (provider) => {
      counters.connectorFactoryCalls += 1;
      return new OfflineGuidedConnector(provider);
    },
    youtubeClient: () => {
      counters.youtubeClientCalls += 1;
      throw new Error("YOUTUBE_API_NOT_CONFIGURED_OFFLINE_FIXTURE");
    },
  });
  return {
    database,
    sourceSnapshotId,
    targetTrackUrl: destinationTrackUrl(direction[1]),
    destinationPlaylistUrl: destinationPlaylistUrl(direction[1]),
    counters,
    coordinator,
    dispose: () => database.destroyFiles(),
  };
}

export function createMatrixTransfer(
  coordinator: TransferCoordinator,
  harness: CoordinatorHarness,
  input: CoordinatorMatrixCase,
) {
  return coordinator.create({
    sourceProvider: input.direction[0],
    destinationProvider: input.direction[1],
    mode: input.mode,
    selectedPlaylistIds: [harness.sourceSnapshotId],
    settings: {
      matching: {
        riskMode: input.riskMode,
        reviewUncertain: input.reviewUncertain,
      },
    },
    destination: input.mode === "APPEND_EXISTING"
      ? {
          title: `${input.direction[1]} existing synthetic target`,
          playlistUrl: harness.destinationPlaylistUrl,
          ownershipAttested: true,
          editControlAttested: true,
          existingItemIds: [],
          existingItemCount: 0,
        }
      : {
          title: `${input.direction[1]} new synthetic target`,
          ownershipAttested: true,
          editControlAttested: true,
        },
  });
}
