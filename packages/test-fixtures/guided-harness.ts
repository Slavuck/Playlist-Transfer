import {
  classifyTrackItemOutcome,
  createProviderValidation,
  createTransferBlueprint,
  createTransferSettings,
  createUserConfirmedManualReceipt,
  materializeWritePlan,
  transitionTrackItem,
  transitionTransfer,
  type ImmutableWritePlan,
  type Provider,
  type ProviderTrackReference,
  type TrackItemState,
  type TransferMode,
  type UserConfirmedManualWriteReceipt,
} from "../domain/src/index.js";
import { buildTrackHypotheses, decideMatch, scoreCandidateForSource } from "../matching/src/index.js";
import { GuidedConnector } from "../connectors-core/src/guided-connector.js";
import type { GuidedAction } from "../connectors-core/src/types.js";
import type { ProviderDirection } from "./gold-dataset.js";

export const TRANSFER_MODES = ["SEPARATE_COPY", "MERGE_NEW", "APPEND_EXISTING"] as const satisfies readonly TransferMode[];

export interface GuidedScenarioInput {
  readonly direction: ProviderDirection;
  readonly mode: TransferMode;
  readonly riskMode: "SAFE" | "RISKY";
  readonly reviewUncertain: boolean;
}

export interface GuidedScenarioResult {
  readonly settingsBehavior: ReturnType<typeof decideMatch>["kind"];
  readonly transferStates: readonly string[];
  readonly trackStates: readonly TrackItemState[];
  readonly plan: ImmutableWritePlan;
  readonly action: GuidedAction;
  readonly receipt: UserConfirmedManualWriteReceipt;
  readonly assurance: ReturnType<typeof classifyTrackItemOutcome>;
  readonly soundcloudExternalGate: boolean;
}

function idFor(provider: Provider): string {
  if (provider === "spotify") return "AbCdEf0123456789GhIjKl";
  if (provider === "youtube") return "AbCdEf01_-2";
  return "https://soundcloud.com/synthetic-catalog/guided-track";
}

function targetFor(provider: Provider): ProviderTrackReference {
  const id = idFor(provider);
  const url = provider === "spotify"
    ? `https://open.spotify.com/track/${id}`
    : provider === "youtube"
      ? `https://www.youtube.com/watch?v=${id}`
      : id;
  return {
    provider,
    entityKind: provider === "youtube" ? "video" : "track",
    providerEntityId: id,
    ...(provider === "youtube" ? { videoId: id } : {}),
    providerUriOrUrl: provider === "spotify" ? `spotify:track:${id}` : url,
    containsSecretUrl: false,
    redactedDisplayUrl: url,
    titleRaw: "Guided Signal",
    artistRaw: "Synthetic Artist",
    durationMs: 200_000,
    availability: "AVAILABLE",
    attributionUrl: url,
    fetchedAt: "2026-07-29T13:00:00.000Z",
  };
}

function createPlan(input: GuidedScenarioInput, target: ProviderTrackReference): ImmutableWritePlan {
  const settings = createTransferSettings({
    matching: { riskMode: input.riskMode, reviewUncertain: input.reviewUncertain },
  });
  const validation = createProviderValidation(target, {
    kind: target.provider === "soundcloud" ? "PROVIDER_OEMBED" : "PROVIDER_API",
    provider: target.provider,
    providerEntityId: target.providerEntityId,
    checkedAt: "2026-07-29T13:01:00.000Z",
    exists: true,
    evidenceVersion: "guided-harness-v1",
  });
  const source = {
    sourcePlaylistId: "source-playlist-1",
    title: "Synthetic source",
    selectedItems: [{
      sourceItemId: "source-item-1",
      sourcePosition: 0,
      target,
      validation,
      selectionKind: "MATCHED_AUTO" as const,
      writeStrategy: "GUIDED_USER_ACTION" as const,
    }],
  };
  const transferId = `scenario-${input.direction.join("-to-")}-${input.mode}-${input.riskMode}-${input.reviewUncertain}`;
  const blueprint = input.mode === "SEPARATE_COPY"
    ? createTransferBlueprint({ transferId, destinationProvider: input.direction[1], sources: [source], settings, mode: input.mode })
    : input.mode === "MERGE_NEW"
      ? createTransferBlueprint({ transferId, destinationProvider: input.direction[1], sources: [source], settings, mode: input.mode, mergedMetadata: { title: "Merged synthetic destination" } })
      : createTransferBlueprint({
          transferId,
          destinationProvider: input.direction[1],
          sources: [source],
          settings,
          mode: input.mode,
          existingDestination: {
            providerPlaylistId: "existing-destination-1",
            title: "Existing synthetic destination",
            eligibility: "USER_ATTESTED_OWNED",
            existingProviderEntityIds: [],
            currentItemCount: 0,
          },
        });
  const bindings = Object.fromEntries(blueprint.destinations.map(
    (destination) => [destination.destinationPlanKey, `bound-${input.direction[1]}-playlist`],
  ));
  return materializeWritePlan(blueprint, bindings);
}

function decideUncertain(input: GuidedScenarioInput, target: ProviderTrackReference): ReturnType<typeof decideMatch> {
  const validation = createProviderValidation(target, {
    kind: target.provider === "soundcloud" ? "PROVIDER_OEMBED" : "PROVIDER_API",
    provider: target.provider,
    providerEntityId: target.providerEntityId,
    checkedAt: "2026-07-29T13:01:00.000Z",
    exists: true,
    evidenceVersion: "guided-harness-v1",
  });
  const hypothesis = buildTrackHypotheses({ titleRaw: "Guided Signal", artistRaw: "Synthetic Artist" })[0]!;
  const scored = scoreCandidateForSource({ hypothesis, durationMs: 200_000 }, {
    target: { ...target, artistRaw: undefined },
    validation,
    titleRaw: "Guided Signal",
    providerRank: 1,
  });
  return decideMatch([scored], createTransferSettings({
    matching: { riskMode: input.riskMode, reviewUncertain: input.reviewUncertain },
  }).matching);
}

export function runGuidedScenario(input: GuidedScenarioInput): GuidedScenarioResult {
  const target = targetFor(input.direction[1]);
  const plan = createPlan(input, target);
  const uncertain = decideUncertain(input, target);
  const connector = new GuidedConnector(input.direction[1]);
  const ref = connector.parseUserUrl(target.redactedDisplayUrl);
  const action = connector.buildAddAction(ref, {
    id: plan.destinations[0]!.destinationPlaylistId,
    label: plan.destinations[0]!.metadata.title,
  });

  const transferStates = ["DRAFT"];
  for (const state of ["PREFLIGHT", "SNAPSHOTTING", "MATCHING"] as const) {
    transferStates.push(transitionTransfer(transferStates.at(-1)! as "DRAFT" | "PREFLIGHT" | "SNAPSHOTTING", state));
  }
  if (input.reviewUncertain) transferStates.push(transitionTransfer("MATCHING", "NEEDS_REVIEW"));
  transferStates.push(transitionTransfer(input.reviewUncertain ? "NEEDS_REVIEW" : "MATCHING", "READY_TO_WRITE"));
  transferStates.push(transitionTransfer("READY_TO_WRITE", "WRITING"));

  const trackStates: TrackItemState[] = ["PENDING"];
  trackStates.push(transitionTrackItem(trackStates.at(-1)!, "MATCHED_AUTO"));
  trackStates.push(transitionTrackItem(trackStates.at(-1)!, "WRITE_PENDING"));
  trackStates.push(transitionTrackItem(trackStates.at(-1)!, "AWAITING_USER_RECONCILIATION"));
  const item = plan.destinations[0]!.items[0]!;
  const receipt = createUserConfirmedManualReceipt({
    receiptId: `receipt:${item.idempotencyKey}`,
    transferId: plan.transferId,
    destinationPlaylistId: item.destinationPlaylistId,
    target: item.target,
    idempotencyKey: item.idempotencyKey,
    writtenAt: "2026-07-29T13:02:00.000Z",
  }, {
    kind: "USER_DESTINATION_CONFIRMATION",
    provider: item.target.provider,
    destinationPlaylistId: item.destinationPlaylistId,
    providerEntityId: item.target.providerEntityId,
    confirmedAt: "2026-07-29T13:03:00.000Z",
    userAttestedPresent: true,
  });
  trackStates.push(transitionTrackItem(trackStates.at(-1)!, "USER_CONFIRMED_MANUAL", { receipt }));
  transferStates.push(transitionTransfer("WRITING", "VERIFYING"));
  transferStates.push(transitionTransfer("VERIFYING", "COMPLETED"));

  return {
    settingsBehavior: uncertain.kind,
    transferStates,
    trackStates,
    plan,
    action,
    receipt,
    assurance: classifyTrackItemOutcome("USER_CONFIRMED_MANUAL", receipt),
    soundcloudExternalGate: input.direction[0] === "soundcloud" || input.direction[1] === "soundcloud",
  };
}

export class FakeGuidedJournal {
  readonly #receipts = new Map<string, UserConfirmedManualWriteReceipt>();
  readonly #pending = new Set<string>();

  static restore(serialized: string): FakeGuidedJournal {
    const parsed = JSON.parse(serialized) as { readonly pending: readonly string[]; readonly receipts: readonly UserConfirmedManualWriteReceipt[] };
    const journal = new FakeGuidedJournal();
    for (const key of parsed.pending) journal.#pending.add(key);
    for (const receipt of parsed.receipts) journal.#receipts.set(receipt.idempotencyKey, receipt);
    return journal;
  }

  issue(idempotencyKey: string): "ACTION_REQUIRED" | "ALREADY_CONFIRMED" {
    if (this.#receipts.has(idempotencyKey)) return "ALREADY_CONFIRMED";
    this.#pending.add(idempotencyKey);
    return "ACTION_REQUIRED";
  }

  confirm(receipt: UserConfirmedManualWriteReceipt): UserConfirmedManualWriteReceipt {
    const existing = this.#receipts.get(receipt.idempotencyKey);
    if (existing) return existing;
    if (!this.#pending.has(receipt.idempotencyKey)) throw new Error("No persisted guided action to reconcile");
    this.#receipts.set(receipt.idempotencyKey, receipt);
    this.#pending.delete(receipt.idempotencyKey);
    return receipt;
  }

  serialize(): string {
    return JSON.stringify({ pending: [...this.#pending].sort(), receipts: [...this.#receipts.values()] });
  }
}
