import { createHash, randomUUID } from "node:crypto";
import {
  createProviderValidation,
  createProviderVerifiedReceipt,
  createTransferBlueprint,
  createTransferSettings,
  createUnverifiedReceipt,
  createUserConfirmedManualReceipt,
  estimateYoutubeQuota,
  materializeWritePlan,
  summarizeTrackItemOutcomes,
  transitionTrackItem,
  transitionTransfer,
  type CandidateValidation,
  type ImmutableWritePlan,
  type MatchSelectionKind,
  type PlannerSourcePlaylist,
  type Provider,
  type ProviderTrackReference,
  type TrackItemState,
  type TransferBlueprint,
  type TransferMode,
  type TransferSettings,
  type TransferState,
  type WriteReceipt,
} from "../../domain/src/index";
import {
  buildSearchQueries,
  buildTrackHypotheses,
  decideMatch,
  scoreCandidateForSource,
  type MatchCandidateInput,
  type ScoredCandidate,
  type TrackHypothesis,
} from "../../matching/src/index";
import { GuidedConnector } from "../../connectors-core/src/guided-connector";
import { buildSearchUrl, parseProviderUrl } from "../../connectors-core/src/url-policy";
import { providerLimitations } from "../../connectors-core/src/policy";
import type { GuidedAction, ProviderConnector, ProviderEntityRef, ValidationResult } from "../../connectors-core/src/types";
import { loadLocalYoutubeClient } from "../../connectors/youtube/src/local";
import { youtubeQuotaPeriodKey, type YoutubeApiClient, type YoutubeCandidate } from "../../connectors/youtube/src/client";
import {
  getLocalDatabase,
  type JsonObject,
  type LocalDatabase,
  type TransferRecord,
} from "../../storage-local/src/database";
import { redactSecrets } from "../../storage-local/src/vault";

const ACTIVE_ITEM_STATES = new Set<TrackItemState>([
  "PENDING",
  "MATCHED_AUTO",
  "NEEDS_REVIEW",
  "USER_SELECTED",
  "WRITE_PENDING",
  "AWAITING_USER_RECONCILIATION",
  "WRITTEN",
]);

type SnapshotTrack = {
  position: number;
  titleRaw: string;
  artistRaw?: string;
  durationMs?: number;
  embeddable?: boolean;
  unavailable?: boolean;
  providerEntityId?: string;
  videoId?: string;
  providerUriOrUrl?: string;
  attributionUrl?: string;
};

type SnapshotRecord = {
  id: string;
  provider: Provider;
  providerUrl: string;
  title: string;
  description?: string;
  eligibility: string;
  partial: boolean;
  sourceVersion: string;
  snapshot: { tracks: SnapshotTrack[] };
};

type StoredCandidate = {
  candidateId: string;
  target: ProviderTrackReference;
  validation: CandidateValidation;
  score: number;
  rank: number;
  evidence: unknown[];
  conflicts: readonly string[];
  riskBadge: boolean;
  embeddable: boolean;
  provenance: {
    source: "PROVIDER_API" | "PROVIDER_OEMBED" | "URL_SYNTAX_ONLY";
    validationStatus: CandidateValidation["status"];
    exactIdParsed: true;
    providerReadBack: boolean;
    providerExistenceConfirmed: boolean;
    metadataFields: readonly ("title" | "artist" | "duration" | "embeddable")[];
    checkedAt: string;
    limitations: readonly string[];
  };
};

type StoredItem = {
  id: string;
  transferId: string;
  sourcePlaylistId: string;
  sourcePosition: number;
  state: TrackItemState;
  sourceRef: ProviderTrackReference;
  hypotheses: TrackHypothesis[];
  candidates: StoredCandidate[];
  decision?: JsonObject;
  selectedTarget?: {
    target: ProviderTrackReference;
    validation: CandidateValidation;
    selectionKind: MatchSelectionKind;
    writeStrategy: "API" | "GUIDED_USER_ACTION";
  };
  idempotencyKey?: string;
  riskFlags: string[];
  updatedAtMs: number;
};

type DestinationState = {
  title: string;
  description?: string;
  privacy?: string;
  playlistUrl?: string;
  providerPlaylistId?: string;
  ownershipAttested: boolean;
  editControlAttested: boolean;
  allowPartial: boolean;
  existingItemIds: string[];
  existingItemCount: number;
  destinationSnapshotAtMs?: number;
  destinationSnapshotVersion?: string;
  forceGuided: boolean;
  retainedSummary?: JsonObject;
  rawDetailExpiredAtMs?: number;
  eligibility?: string;
  blueprint?: TransferBlueprint;
  bindings: Record<string, {
    providerPlaylistId: string;
    playlistUrl?: string;
    title: string;
    eligibility?: "USER_ATTESTED_OWNED" | "PROVIDER_VERIFIED_OWNED";
    newPlaylistAttested?: true;
    initialVisibleItemCount?: 0;
    boundAtMs?: number;
  }>;
};

export type CreateTransferInput = {
  sourceProvider: Provider;
  destinationProvider: Provider;
  mode: TransferMode;
  selectedPlaylistIds: string[];
  settings?: Partial<Omit<TransferSettings, "matching">> & {
    matching?: Partial<TransferSettings["matching"]>;
  };
  allowPartial?: boolean;
  destination?: {
    title?: string;
    description?: string;
    privacy?: string;
    playlistUrl?: string;
    providerPlaylistId?: string;
    ownershipAttested?: boolean;
    editControlAttested?: boolean;
    existingItemIds?: string[];
    existingItemCount?: number;
  };
};

export type ReconciliationResult = "present" | "absent" | "unknown";

export type CoordinatorDependencies = {
  database?: LocalDatabase;
  guidedConnector?: (provider: Provider) => ProviderConnector;
  youtubeClient?: () => YoutubeApiClient;
  now?: () => Date;
  /** Test-only seam for exercising the deterministic matcher behind its release policy gate. */
  allowPolicyGatedAutoMatchingForTests?: boolean;
};

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function asProvider(value: unknown): Provider {
  if (value === "spotify" || value === "soundcloud" || value === "youtube") return value;
  throw new Error("UNKNOWN_PROVIDER");
}

function asTransferState(value: string): TransferState {
  return value as TransferState;
}

function destinationOf(transfer: TransferRecord): DestinationState {
  const value = transfer.destination as Partial<DestinationState>;
  return {
    title: typeof value.title === "string" && value.title.trim() ? value.title : "Transferred playlist",
    description: typeof value.description === "string" ? value.description : undefined,
    privacy: typeof value.privacy === "string" ? value.privacy : undefined,
    playlistUrl: typeof value.playlistUrl === "string" ? value.playlistUrl : undefined,
    providerPlaylistId: typeof value.providerPlaylistId === "string" ? value.providerPlaylistId : undefined,
    ownershipAttested: value.ownershipAttested === true,
    editControlAttested: value.editControlAttested === true,
    allowPartial: value.allowPartial === true,
    existingItemIds: Array.isArray(value.existingItemIds) ? value.existingItemIds.filter((id): id is string => typeof id === "string") : [],
    existingItemCount: Number.isSafeInteger(value.existingItemCount) && Number(value.existingItemCount) >= 0 ? Number(value.existingItemCount) : 0,
    destinationSnapshotAtMs: typeof value.destinationSnapshotAtMs === "number" ? value.destinationSnapshotAtMs : undefined,
    destinationSnapshotVersion: typeof value.destinationSnapshotVersion === "string" ? value.destinationSnapshotVersion : undefined,
    forceGuided: value.forceGuided === true,
    retainedSummary: value.retainedSummary && typeof value.retainedSummary === "object" ? value.retainedSummary as JsonObject : undefined,
    rawDetailExpiredAtMs: typeof value.rawDetailExpiredAtMs === "number" ? value.rawDetailExpiredAtMs : undefined,
    eligibility: typeof value.eligibility === "string" ? value.eligibility : undefined,
    blueprint: value.blueprint as TransferBlueprint | undefined,
    bindings: value.bindings && typeof value.bindings === "object" ? value.bindings : {},
  };
}

function json(value: unknown): JsonObject {
  return value as JsonObject;
}

function iso(now: () => Date): string {
  return now().toISOString();
}

function countById(values: readonly string[], target: string): number {
  return values.reduce((total, value) => total + (value === target ? 1 : 0), 0);
}

function safePlaylistId(provider: Provider, urlOrId: string): { id: string; url?: string } {
  if (/^https:\/\//.test(urlOrId)) {
    const ref = parseProviderUrl(provider, urlOrId);
    if (ref.entityKind !== "playlist") throw new Error("DESTINATION_PLAYLIST_URL_REQUIRED");
    if (ref.containsSecretUrl) throw new Error("PRIVATE_DESTINATION_URL_NOT_PERSISTED");
    const id = ref.playlistId ?? ref.providerEntityId;
    if (!id) throw new Error("DESTINATION_PLAYLIST_ID_REQUIRED");
    return { id, url: ref.redactedDisplayUrl };
  }
  return { id: requiredText(urlOrId, "DESTINATION_PLAYLIST_ID_REQUIRED") };
}

function sourceReference(provider: Provider, track: SnapshotTrack): ProviderTrackReference {
  const providerEntityId = requiredText(track.providerEntityId ?? track.videoId, "SOURCE_PROVIDER_ENTITY_ID_REQUIRED");
  const url = requiredText(track.providerUriOrUrl ?? track.attributionUrl, "SOURCE_PROVIDER_URL_REQUIRED");
  const videoId = provider === "youtube" ? requiredText(track.videoId ?? providerEntityId, "YOUTUBE_VIDEO_ID_REQUIRED") : undefined;
  return {
    provider,
    entityKind: provider === "youtube" ? "video" : "track",
    providerEntityId,
    providerUriOrUrl: url,
    containsSecretUrl: false,
    redactedDisplayUrl: track.attributionUrl ?? url,
    videoId,
    titleRaw: requiredText(track.titleRaw, "SOURCE_TITLE_REQUIRED"),
    artistRaw: track.artistRaw,
    channelRaw: provider === "youtube" ? track.artistRaw : undefined,
    durationMs: track.durationMs,
    embeddable: track.embeddable === true,
    availability: track.unavailable ? "UNAVAILABLE" : "AVAILABLE",
    attributionUrl: track.attributionUrl ?? url,
    fetchedAt: new Date().toISOString(),
  };
}

function targetReference(ref: ProviderEntityRef, now: () => Date): ProviderTrackReference {
  const providerEntityId = requiredText(ref.providerEntityId ?? ref.videoId, "TARGET_PROVIDER_ENTITY_ID_REQUIRED");
  return {
    provider: ref.provider,
    entityKind: ref.provider === "youtube" ? "video" : "track",
    providerEntityId,
    providerUriOrUrl: ref.providerUriOrUrl,
    containsSecretUrl: ref.containsSecretUrl,
    redactedDisplayUrl: ref.redactedDisplayUrl,
    videoId: ref.provider === "youtube" ? requiredText(ref.videoId, "YOUTUBE_VIDEO_ID_REQUIRED") : undefined,
    // The domain requires a non-empty display label, but URL syntax alone does
    // not provide provider metadata. Never borrow the source title here.
    titleRaw: ref.titleRaw?.trim() || `URL-only target ${providerEntityId}`,
    artistRaw: ref.artistRaw?.trim() || undefined,
    channelRaw: ref.provider === "youtube" ? ref.artistRaw?.trim() || undefined : undefined,
    durationMs: ref.durationMs,
    embeddable: ref.embeddable,
    availability: ref.validationStatus === "PROVIDER_VALIDATED" ? "AVAILABLE" : "UNKNOWN",
    attributionUrl: ref.attributionUrl,
    fetchedAt: ref.fetchedAt ? new Date(ref.fetchedAt).toISOString() : iso(now),
  };
}

function youtubeTarget(candidate: YoutubeCandidate, now: () => Date): ProviderTrackReference {
  return {
    provider: "youtube",
    entityKind: "video",
    providerEntityId: candidate.videoId,
    videoId: candidate.videoId,
    providerUriOrUrl: candidate.providerUriOrUrl,
    containsSecretUrl: false,
    redactedDisplayUrl: candidate.providerUriOrUrl,
    titleRaw: candidate.titleRaw,
    artistRaw: candidate.artistRaw,
    channelRaw: candidate.artistRaw,
    durationMs: candidate.durationMs,
    embeddable: candidate.embeddable,
    availability: candidate.availability,
    attributionUrl: candidate.providerUriOrUrl,
    fetchedAt: iso(now),
  };
}

function candidateValidation(target: ProviderTrackReference, now: () => Date): CandidateValidation & { status: "PROVIDER_VALIDATED" } {
  return createProviderValidation(target, {
    kind: "PROVIDER_API",
    provider: target.provider,
    providerEntityId: target.providerEntityId,
    checkedAt: iso(now),
    exists: true,
    evidenceVersion: "youtube-data-api-v3",
  });
}

function candidateProvenance(
  target: ProviderTrackReference,
  validation: CandidateValidation,
  input?: Pick<ValidationResult, "evidence" | "limitations">,
): StoredCandidate["provenance"] {
  const providerReadBack = validation.status === "PROVIDER_VALIDATED" && input?.evidence.providerReadBack !== false;
  const source = validation.status === "PROVIDER_VALIDATED"
    ? validation.evidence.kind === "PROVIDER_OEMBED" ? "PROVIDER_OEMBED" : "PROVIDER_API"
    : "URL_SYNTAX_ONLY";
  const metadataFields: StoredCandidate["provenance"]["metadataFields"] = providerReadBack
    ? [
        ...(target.titleRaw.trim() ? ["title" as const] : []),
        ...(target.artistRaw?.trim() ? ["artist" as const] : []),
        ...(target.durationMs !== undefined ? ["duration" as const] : []),
        ...(target.embeddable !== undefined ? ["embeddable" as const] : []),
      ]
    : [];
  return {
    source,
    validationStatus: validation.status,
    exactIdParsed: true,
    providerReadBack,
    providerExistenceConfirmed: providerReadBack,
    metadataFields,
    checkedAt: validation.status === "PROVIDER_VALIDATED"
      ? validation.evidence.checkedAt
      : new Date(input?.evidence.checkedAt ?? Date.parse(target.fetchedAt)).toISOString(),
    limitations: input?.limitations ?? (providerReadBack ? [] : ["URL_SYNTAX_ONLY_ENTITY_EXISTENCE_NOT_CONFIRMED"]),
  };
}

function persistItem(database: LocalDatabase, item: StoredItem): void {
  database.saveTransferItem({
    id: item.id,
    transferId: item.transferId,
    sourcePlaylistId: item.sourcePlaylistId,
    sourcePosition: item.sourcePosition,
    state: item.state,
    sourceRef: json(item.sourceRef),
    hypotheses: item.hypotheses,
    candidates: item.candidates,
    decision: item.decision,
    selectedTarget: item.selectedTarget ? json(item.selectedTarget) : undefined,
    idempotencyKey: item.idempotencyKey,
    riskFlags: item.riskFlags,
  });
}

function mapStoredItem(value: JsonObject): StoredItem {
  return {
    id: String(value.id),
    transferId: String(value.transferId),
    sourcePlaylistId: String(value.sourcePlaylistId),
    sourcePosition: Number(value.sourcePosition),
    state: String(value.state) as TrackItemState,
    sourceRef: value.sourceRef as ProviderTrackReference,
    hypotheses: (Array.isArray(value.hypotheses) ? value.hypotheses : []) as TrackHypothesis[],
    candidates: (Array.isArray(value.candidates) ? value.candidates : []) as StoredCandidate[],
    decision: value.decision as JsonObject | undefined,
    selectedTarget: value.selectedTarget as StoredItem["selectedTarget"],
    idempotencyKey: typeof value.idempotencyKey === "string" ? value.idempotencyKey : undefined,
    riskFlags: Array.isArray(value.riskFlags) ? value.riskFlags.filter((flag): flag is string => typeof flag === "string") : [],
    updatedAtMs: Number(value.updatedAtMs ?? 0),
  };
}

function publicCandidate(scored: ScoredCandidate, rank: number, riskBadge: boolean): StoredCandidate {
  return {
    candidateId: randomUUID(),
    target: scored.candidate.target,
    validation: scored.candidate.validation,
    score: scored.score,
    rank,
    evidence: [...scored.evidence],
    conflicts: scored.conflicts,
    riskBadge,
    embeddable: scored.candidate.embeddable === true,
    provenance: candidateProvenance(scored.candidate.target, scored.candidate.validation),
  };
}

function activeReceipt(receipts: JsonObject[], itemId: string): WriteReceipt | undefined {
  const row = receipts.find((receipt) => receipt.transferItemId === itemId);
  const evidence = row?.evidence as JsonObject | undefined;
  return evidence?.domainReceipt as WriteReceipt | undefined;
}

function reportFor(database: LocalDatabase, transferId: string, items: StoredItem[]) {
  const receipts = database.listReceipts(transferId);
  const inputs = items.map((item) => ({ state: item.state, receipt: activeReceipt(receipts, item.id) }));
  const counts = summarizeTrackItemOutcomes(inputs);
  return {
    counts,
    successful: counts.VERIFIED_PROVIDER + counts.USER_CONFIRMED_MANUAL,
    independentlyVerified: counts.VERIFIED_PROVIDER,
    userConfirmedOnly: counts.USER_CONFIRMED_MANUAL,
    notCountedAsSuccess: counts.UNVERIFIED + counts.ERROR + counts.SKIPPED + counts.IN_PROGRESS,
    disclaimer: "USER_CONFIRMED_MANUAL is a user attestation, not independent provider verification.",
    items: items.map((item) => {
      const receipt = activeReceipt(receipts, item.id);
      const target = item.selectedTarget?.target;
      return {
        transferItemId: item.id,
        sourcePlaylistId: item.sourcePlaylistId,
        sourcePosition: item.sourcePosition,
        state: item.state,
        sourceProviderEntityId: item.sourceRef.providerEntityId,
        targetProviderEntityId: target?.providerEntityId,
        videoId: target?.provider === "youtube" ? target.videoId : undefined,
        verificationStatus: receipt?.verificationStatus,
        assurance: receipt?.verificationStatus === "VERIFIED_PROVIDER" ? "INDEPENDENT_PROVIDER_READ_BACK" : receipt?.verificationStatus === "USER_CONFIRMED_MANUAL" ? "USER_ATTESTATION_ONLY" : "NO_VERIFICATION",
        riskFlags: item.riskFlags,
      };
    }),
  };
}

function reportWithRetained(
  database: LocalDatabase,
  transferId: string,
  items: StoredItem[],
  retained?: JsonObject,
): ReturnType<typeof reportFor> & { totalItems: number } {
  const live = reportFor(database, transferId, items);
  if (!retained) return { ...live, totalItems: items.length };
  return {
    ...live,
    counts: retained.counts && typeof retained.counts === "object"
      ? retained.counts as ReturnType<typeof reportFor>["counts"]
      : live.counts,
    successful: typeof retained.successful === "number" ? retained.successful : live.successful,
    independentlyVerified: typeof retained.independentlyVerified === "number" ? retained.independentlyVerified : live.independentlyVerified,
    userConfirmedOnly: typeof retained.userConfirmedOnly === "number" ? retained.userConfirmedOnly : live.userConfirmedOnly,
    notCountedAsSuccess: typeof retained.notCountedAsSuccess === "number" ? retained.notCountedAsSuccess : live.notCountedAsSuccess,
    disclaimer: typeof retained.disclaimer === "string" ? retained.disclaimer : live.disclaimer,
    totalItems: typeof retained.totalItems === "number" ? retained.totalItems : items.length,
  };
}

function saveReceipt(database: LocalDatabase, item: StoredItem, receipt: WriteReceipt, risky: boolean): void {
  database.saveReceipt({
    id: receipt.receiptId,
    transferId: receipt.transferId,
    transferItemId: item.id,
    destinationPlaylistId: receipt.destinationPlaylistId,
    targetEntityId: receipt.target.providerEntityId,
    idempotencyKey: receipt.idempotencyKey,
    executionStatus: "WRITTEN",
    verificationStatus: receipt.verificationStatus,
    evidence: { domainReceipt: receipt, assurance: receipt.verificationStatus === "VERIFIED_PROVIDER" ? "INDEPENDENT_PROVIDER_READ_BACK" : receipt.verificationStatus === "USER_CONFIRMED_MANUAL" ? "USER_ATTESTATION_ONLY" : "NO_VERIFICATION" },
    risky,
    manual: receipt.verificationStatus === "USER_CONFIRMED_MANUAL",
  });
}

function withLimitations(transfer: TransferRecord, ...codes: string[]): TransferRecord {
  return { ...transfer, limitationCodes: [...new Set([...transfer.limitationCodes, ...codes.filter(Boolean)])] };
}

function withoutLimitations(transfer: TransferRecord, ...codes: string[]): TransferRecord {
  const removed = new Set(codes);
  return { ...transfer, limitationCodes: transfer.limitationCodes.filter((code) => !removed.has(code)) };
}

function journalSequence(database: LocalDatabase, transferId: string): number {
  const journal = database.listJournal(transferId);
  return journal.reduce((max, entry) => Math.max(max, Number(entry.sequence ?? 0)), 0) + 1;
}

function baseReceipt(item: StoredItem, transferId: string, destinationPlaylistId: string, writtenAt: string) {
  if (!item.selectedTarget || !item.idempotencyKey) throw new Error("WRITE_PLAN_ITEM_INCOMPLETE");
  return {
    receiptId: randomUUID(),
    transferId,
    destinationPlaylistId,
    target: item.selectedTarget.target,
    idempotencyKey: item.idempotencyKey,
    writtenAt,
  };
}

function selectedPlannerSources(snapshots: SnapshotRecord[], items: StoredItem[], privacy?: string): PlannerSourcePlaylist[] {
  return snapshots.map((snapshot) => ({
    sourcePlaylistId: snapshot.id,
    title: snapshot.title,
    description: snapshot.description,
    privacy,
    selectedItems: items
      .filter((item) => item.sourcePlaylistId === snapshot.id && item.selectedTarget)
      .map((item) => ({
        sourceItemId: item.id,
        sourcePosition: item.sourcePosition,
        target: item.selectedTarget!.target,
        validation: item.selectedTarget!.validation,
        selectionKind: item.selectedTarget!.selectionKind,
        writeStrategy: item.selectedTarget!.writeStrategy,
      })),
  }));
}

function findPlanItem(plan: ImmutableWritePlan, itemId: string) {
  for (const destination of plan.destinations) {
    const item = destination.items.find((candidate) => candidate.sourceItemId === itemId);
    if (item) return item;
  }
  return undefined;
}

export class TransferCoordinator {
  private readonly database: LocalDatabase;
  private readonly guidedConnector: (provider: Provider) => ProviderConnector;
  private readonly youtubeClient: () => YoutubeApiClient;
  private readonly now: () => Date;
  private readonly allowPolicyGatedAutoMatchingForTests: boolean;
  private readonly locks = new Set<string>();
  private readonly leaseContexts = new Map<string, {
    transferOwnerId: string;
    resourceOwnerId: string;
    resources: string[];
  }>();

  constructor(dependencies: CoordinatorDependencies = {}) {
    this.database = dependencies.database ?? getLocalDatabase();
    this.guidedConnector = dependencies.guidedConnector ?? ((provider) => new GuidedConnector(provider));
    this.youtubeClient = dependencies.youtubeClient ?? loadLocalYoutubeClient;
    this.now = dependencies.now ?? (() => new Date());
    this.allowPolicyGatedAutoMatchingForTests = dependencies.allowPolicyGatedAutoMatchingForTests === true;
  }

  private snapshots(transfer: TransferRecord): SnapshotRecord[] {
    const available = new Map(
      this.database.listPlaylistSnapshots(transfer.sourceProvider).map((snapshot) => [String(snapshot.id), snapshot]),
    );
    return transfer.selectedPlaylistIds
      .map((id) => available.get(id))
      .filter((snapshot): snapshot is JsonObject => Boolean(snapshot)) as unknown as SnapshotRecord[];
  }

  private items(transferId: string): StoredItem[] {
    return this.database.listTransferItems(transferId).map(mapStoredItem);
  }

  private saveTransfer(transfer: TransferRecord): TransferRecord {
    const updated = { ...transfer, updatedAtMs: this.now().getTime() };
    this.database.saveTransfer(updated);
    return updated;
  }

  private destinationResourceKeys(transfer: TransferRecord): string[] {
    const destination = destinationOf(transfer);
    const ids = new Set<string>();
    if (destination.providerPlaylistId) ids.add(destination.providerPlaylistId);
    for (const binding of Object.values(destination.bindings)) ids.add(binding.providerPlaylistId);
    return [...ids]
      .map((id) => `destination:${createHash("sha256").update(`${transfer.destinationProvider}:${id}`).digest("hex")}`)
      .sort();
  }

  private renewLease(transferId: string): boolean {
    const context = this.leaseContexts.get(transferId);
    if (!context) return false;
    const transferOk = this.database.renewTransferLease(transferId, context.transferOwnerId);
    const resourcesOk = context.resources
      .every((key) => this.database.renewResourceLease(key, context.resourceOwnerId));
    return transferOk && resourcesOk;
  }

  private async locked<T>(transferId: string, work: () => Promise<T>): Promise<T> {
    if (this.locks.has(transferId)) throw new Error("TRANSFER_BUSY");
    if (!this.database.getTransfer(transferId)) throw new Error("TRANSFER_NOT_FOUND");
    const transferOwnerId = randomUUID();
    if (!this.database.acquireTransferLease(transferId, transferOwnerId)) throw new Error("TRANSFER_BUSY");
    // The transfer may have been bound to a destination while this caller waited.
    // Always derive destination locks from the record protected by the transfer lease.
    const transfer = this.database.getTransfer(transferId);
    if (!transfer) {
      this.database.releaseTransferLease(transferId, transferOwnerId);
      throw new Error("TRANSFER_NOT_FOUND");
    }
    const awaitingReservation = this.database.listJournal(transferId).find((entry) => entry.status === "AWAITING_USER");
    const awaitingPayload = (awaitingReservation?.payload ?? {}) as JsonObject;
    const persistedResourceOwner = typeof awaitingPayload.resourceLeaseOwnerId === "string"
      ? awaitingPayload.resourceLeaseOwnerId
      : undefined;
    const resourceOwnerId = persistedResourceOwner ?? randomUUID();
    const resources = this.destinationResourceKeys(transfer);
    const acquired: string[] = [];
    for (const resource of resources) {
      if (!this.database.acquireResourceLease(resource, resourceOwnerId)) {
        for (const key of acquired) this.database.releaseResourceLease(key, resourceOwnerId);
        this.database.releaseTransferLease(transferId, transferOwnerId);
        throw new Error("DESTINATION_BUSY");
      }
      acquired.push(resource);
    }
    if (awaitingReservation && !persistedResourceOwner) {
      this.database.appendJournal({
        transferId,
        sequence: Number(awaitingReservation.sequence),
        stepKind: String(awaitingReservation.stepKind),
        stepKey: String(awaitingReservation.stepKey),
        status: String(awaitingReservation.status),
        payload: { ...awaitingPayload, resourceLeaseOwnerId: resourceOwnerId },
        attempt: Number(awaitingReservation.attempt ?? 0),
      });
    }
    this.locks.add(transferId);
    this.leaseContexts.set(transferId, { transferOwnerId, resourceOwnerId, resources: acquired });
    const heartbeat = setInterval(() => {
      try { this.renewLease(transferId); } catch { /* explicit renewals fail closed before mutations */ }
    }, 30_000);
    heartbeat.unref?.();
    try {
      return await work();
    } finally {
      clearInterval(heartbeat);
      this.locks.delete(transferId);
      this.leaseContexts.delete(transferId);
      const reservationStillAwaiting = this.database.listJournal(transferId).some((entry) => {
        const payload = (entry.payload ?? {}) as JsonObject;
        return entry.status === "AWAITING_USER" && payload.resourceLeaseOwnerId === resourceOwnerId;
      });
      if (reservationStillAwaiting) {
        // A user-operated action can span page reloads or a process restart. Keep the
        // destination reserved for the support window; the count confirmation still
        // fails closed if the user returns after this lease has expired.
        for (const resource of acquired) this.database.renewResourceLease(resource, resourceOwnerId, 24 * 60 * 60 * 1_000);
      } else {
        for (const resource of acquired) this.database.releaseResourceLease(resource, resourceOwnerId);
      }
      this.database.releaseTransferLease(transferId, transferOwnerId);
    }
  }

  create(input: CreateTransferInput): TransferRecord {
    const sourceProvider = asProvider(input.sourceProvider);
    const destinationProvider = asProvider(input.destinationProvider);
    const soundcloudManualOnly = sourceProvider === "soundcloud" || destinationProvider === "soundcloud";
    if (sourceProvider === destinationProvider) throw new Error("CROSS_SERVICE_DIRECTION_REQUIRED");
    if (!["SEPARATE_COPY", "MERGE_NEW", "APPEND_EXISTING"].includes(input.mode)) throw new Error("UNKNOWN_TRANSFER_MODE");
    const ids = [...new Set(input.selectedPlaylistIds.map((id) => requiredText(id, "SOURCE_PLAYLIST_ID_REQUIRED")))];
    if (!ids.length) throw new Error("SOURCE_PLAYLIST_REQUIRED");
    const available = this.database.listPlaylistSnapshots(sourceProvider);
    if (ids.some((id) => !available.some((snapshot) => snapshot.id === id))) throw new Error("SOURCE_PLAYLIST_NOT_FOUND");
    const settings = createTransferSettings(input.settings);
    const rawDestination = input.destination ?? {};
    let providerPlaylistId = rawDestination.providerPlaylistId?.trim() || undefined;
    let playlistUrl = rawDestination.playlistUrl?.trim() || undefined;
    if (input.mode === "APPEND_EXISTING") {
      const parsed = safePlaylistId(destinationProvider, playlistUrl || providerPlaylistId || "");
      providerPlaylistId = parsed.id;
      playlistUrl = parsed.url ?? playlistUrl;
      if (!rawDestination.ownershipAttested || !rawDestination.editControlAttested) {
        throw new Error("DESTINATION_OWNER_AND_EDIT_ATTESTATION_REQUIRED");
      }
    }
    const now = this.now().getTime();
    const record: TransferRecord = {
      id: randomUUID(),
      state: "DRAFT",
      sourceProvider,
      destinationProvider,
      mode: input.mode,
      settings: json(settings),
      selectedPlaylistIds: ids,
      destination: json({
        title: rawDestination.title?.trim() || "Transferred playlist",
        description: rawDestination.description?.trim() || undefined,
        privacy: rawDestination.privacy ?? "private",
        playlistUrl,
        providerPlaylistId,
        ownershipAttested: rawDestination.ownershipAttested === true,
        editControlAttested: rawDestination.editControlAttested === true,
        allowPartial: input.allowPartial === true,
        existingItemIds: rawDestination.existingItemIds ?? [],
        existingItemCount: rawDestination.existingItemCount ?? 0,
        destinationSnapshotAtMs: input.mode === "APPEND_EXISTING" ? now : undefined,
        bindings: {},
        // SC-BASE-LEGAL remains unknown, so a SoundCloud direction may use
        // only explicit user-operated cards. The application never turns an
        // optional YouTube connection into automatic cross-service writes for
        // this path.
        forceGuided: soundcloudManualOnly,
      }),
      limitationCodes: [
        ...providerLimitations[sourceProvider],
        ...providerLimitations[destinationProvider],
        ...(soundcloudManualOnly ? ["SC-BASE-LEGAL_EXTERNAL_UNKNOWN", "SC-BASE-LEGAL_MANUAL_ONLY"] : []),
        ...(input.mode === "APPEND_EXISTING" && Number(rawDestination.existingItemCount ?? 0) > (rawDestination.existingItemIds?.length ?? 0)
          ? ["DESTINATION_CONTENT_IDS_PARTIAL_USER_ATTESTED"]
          : []),
        ...(settings.copyCover ? ["COVER_COPY_BEST_EFFORT_UNAVAILABLE_IN_LOCAL_BASELINE"] : []),
      ],
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.database.saveTransfer(record);
    this.database.audit("TRANSFER_DRAFT_CREATED", record.id, {
      sourceProvider,
      destinationProvider,
      mode: input.mode,
      sourceCount: ids.length,
    });
    return record;
  }

  private updateState(transfer: TransferRecord, next: TransferState): TransferRecord {
    return this.saveTransfer({ ...transfer, state: transitionTransfer(asTransferState(transfer.state), next) });
  }

  private async preflight(transfer: TransferRecord): Promise<TransferRecord> {
    const destination = destinationOf(transfer);
    const snapshots = this.snapshots(transfer);
    const connections = new Map(this.database.listConnections().map((connection) => [connection.provider, connection]));
    if (!connections.has(asProvider(transfer.sourceProvider))) throw new Error(`SERVICE_CONNECTION_REQUIRED:${transfer.sourceProvider}`);
    if (!connections.has(asProvider(transfer.destinationProvider))) throw new Error(`SERVICE_CONNECTION_REQUIRED:${transfer.destinationProvider}`);
    if (snapshots.length !== transfer.selectedPlaylistIds.length) throw new Error("SOURCE_SNAPSHOT_MISSING");
    if (snapshots.some((snapshot) => snapshot.provider !== transfer.sourceProvider)) throw new Error("SOURCE_PROVIDER_MISMATCH");
    if (snapshots.some((snapshot) => snapshot.partial) && !destination.allowPartial) throw new Error("PARTIAL_SNAPSHOT_REQUIRES_EXPLICIT_CONTINUE");
    if (snapshots.some((snapshot) => snapshot.eligibility === "INELIGIBLE")) throw new Error("SOURCE_PLAYLIST_INELIGIBLE");
    const settings = transfer.settings as unknown as TransferSettings;
    if (settings.unavailableItems === "STOP_BEFORE_WRITE" && snapshots.some((snapshot) => snapshot.snapshot.tracks.some((track) => track.unavailable))) {
      throw new Error("SOURCE_UNAVAILABLE_ITEM_BLOCKED_BY_SETTINGS");
    }

    let nextDestination = destination;
    let nextTransfer = transfer;
    if (transfer.mode === "APPEND_EXISTING") {
      if (!destination.providerPlaylistId) throw new Error("DESTINATION_PLAYLIST_ID_REQUIRED");
      if (transfer.destinationProvider === "youtube") {
        try {
          const owned = await this.youtubeClient().listEligiblePlaylists();
          const match = owned.find((playlist) => playlist.id === destination.providerPlaylistId);
          if (!match) throw new Error("YOUTUBE_DESTINATION_NOT_API_OWNED");
          const snapshot = await this.youtubeClient().verifyPlaylist(destination.providerPlaylistId, []);
          nextDestination = {
            ...destination,
            title: match.title,
            existingItemIds: snapshot.actualVideoIds,
            existingItemCount: snapshot.actualVideoIds.length,
            destinationSnapshotAtMs: snapshot.checkedAt,
            destinationSnapshotVersion: createHash("sha256").update(JSON.stringify(snapshot.actualVideoIds)).digest("hex"),
            eligibility: "PROVIDER_VERIFIED_OWNED",
          };
          nextTransfer = withoutLimitations(nextTransfer, "DESTINATION_CONTENT_IDS_PARTIAL_USER_ATTESTED");
        } catch (error) {
          if (error instanceof Error && error.message === "YOUTUBE_DESTINATION_NOT_API_OWNED") throw error;
          nextDestination = { ...destination, eligibility: "UNVERIFIED_NON_OWNED" };
          nextTransfer = withLimitations(nextTransfer, "YOUTUBE_APPEND_GUIDED_USER_ATTESTED_ONLY");
        }
      } else {
        if (!destination.ownershipAttested || !destination.editControlAttested) {
          throw new Error("DESTINATION_OWNER_AND_EDIT_ATTESTATION_REQUIRED");
        }
        nextDestination = { ...destination, eligibility: "USER_ATTESTED_OWNED" };
      }
    }
    return this.saveTransfer({ ...nextTransfer, destination: json(nextDestination) });
  }

  async start(transferId: string) {
    return this.locked(transferId, async () => {
      let transfer = this.database.getTransfer(transferId);
      if (!transfer) throw new Error("TRANSFER_NOT_FOUND");
      if ((transfer.sourceProvider === "soundcloud" || transfer.destinationProvider === "soundcloud") && transfer.state === "DRAFT") {
        this.database.audit("TRANSFER_MANUAL_ONLY_POLICY_GATE", transferId, {
          gate: "SC-BASE-LEGAL",
          status: "UNKNOWN",
          applicationAutomationEnabled: false,
          userOperatedGuidedPathEnabled: true,
        });
      }
      if (!["DRAFT", "PREFLIGHT", "SNAPSHOTTING", "MATCHING"].includes(transfer.state)) return this.view(transferId);
      try {
        if (transfer.state === "DRAFT") transfer = this.updateState(transfer, "PREFLIGHT");
        if (transfer.state === "PREFLIGHT") {
          this.database.appendJournal({ transferId, sequence: journalSequence(this.database, transferId), stepKind: "PREFLIGHT", stepKey: "preflight:v1", status: "RUNNING" });
          transfer = await this.preflight(transfer);
          const snapshots = this.snapshots(transfer);
          const itemCount = snapshots.reduce((total, snapshot) => total + snapshot.snapshot.tracks.length, 0);
          const destinationCreates = transfer.mode === "APPEND_EXISTING" ? 0 : transfer.mode === "SEPARATE_COPY" ? snapshots.length : 1;
          const fallbackSearches = itemCount;
          const destinationPages = Math.max(1, Math.ceil((destinationOf(transfer).existingItemCount + itemCount) / 50));
          const youtubeQuotaEstimate = transfer.destinationProvider === "youtube"
            ? estimateYoutubeQuota({
                uniquePrimarySearches: itemCount,
                fallbackSearches,
                playlistItemInserts: itemCount,
                playlistCreates: destinationCreates,
                // Each search call uses one general unit and its detail enrichment is another.
                listCalls: itemCount + fallbackSearches,
                enrichmentCalls: itemCount + fallbackSearches,
                // Read-before/write-after verification is paginated at 50 playlist items.
                verificationCalls: itemCount * 2 * destinationPages,
              })
            : undefined;
          if (youtubeQuotaEstimate) {
            const period = youtubeQuotaPeriodKey(this.now());
            const searchUsed = this.database.getQuotaUsage("youtube", "search", period).used;
            const generalUsed = this.database.getQuotaUsage("youtube", "general", period).used;
            if (youtubeQuotaEstimate.searchBucketCalls > 100 - searchUsed || youtubeQuotaEstimate.generalUnits > 10_000 - generalUsed) {
              transfer = this.saveTransfer({
                ...withLimitations(transfer, "YOUTUBE_ESTIMATED_QUOTA_SHORTFALL_GUIDED_FALLBACK"),
                destination: json({ ...destinationOf(transfer), forceGuided: true }),
              });
            }
          }
          this.database.appendJournal({
            transferId,
            sequence: journalSequence(this.database, transferId),
            stepKind: "PREFLIGHT",
            stepKey: "preflight:v1",
            status: "COMPLETED",
            payload: {
              itemCount,
              destinationCreates,
              estimatedGuidedUserActions: itemCount * 3 + destinationCreates * 3,
              youtubeQuotaEstimate: youtubeQuotaEstimate ? json(youtubeQuotaEstimate) : null,
              providerMutationPerformed: false,
            },
          });
          transfer = this.updateState(transfer, "SNAPSHOTTING");
        }
        if (transfer.state === "SNAPSHOTTING") {
          this.database.appendJournal({ transferId, sequence: journalSequence(this.database, transferId), stepKind: "SNAPSHOT", stepKey: "snapshots:v1", status: "COMPLETED", payload: { snapshotIds: transfer.selectedPlaylistIds } });
          transfer = this.updateState(transfer, "MATCHING");
        }
        if (transfer.state === "MATCHING") {
          transfer = await this.match(transfer);
          await this.prepareBlueprint(transfer);
        }
        return this.view(transferId);
      } catch (error) {
        const current = this.database.getTransfer(transferId);
        if (current && ["PREFLIGHT", "SNAPSHOTTING", "MATCHING", "NEEDS_REVIEW", "READY_TO_WRITE", "WRITING"].includes(current.state)) {
          try {
            this.saveTransfer({ ...current, state: transitionTransfer(asTransferState(current.state), "FAILED"), errorCode: error instanceof Error ? error.message : "TRANSFER_FAILED", completedAtMs: this.now().getTime() });
          } catch {
            this.saveTransfer({ ...current, errorCode: error instanceof Error ? error.message : "TRANSFER_FAILED" });
          }
        }
        throw error;
      }
    });
  }

  private async match(transfer: TransferRecord): Promise<TransferRecord> {
    const snapshots = this.snapshots(transfer);
    const existingItems = new Map(this.items(transfer.id).map((item) => [item.id, item]));
    const settings = transfer.settings as unknown as TransferSettings;
    let youtube: YoutubeApiClient | undefined;
    let youtubeUnavailable: string | undefined;
    if (transfer.destinationProvider === "youtube"
      && !destinationOf(transfer).forceGuided
      && this.allowPolicyGatedAutoMatchingForTests) {
      try {
        youtube = this.youtubeClient();
      } catch (error) {
        youtubeUnavailable = error instanceof Error ? error.message : "YOUTUBE_API_UNAVAILABLE";
      }
    } else if (transfer.destinationProvider === "youtube" && !destinationOf(transfer).forceGuided) {
      youtubeUnavailable = "CROSS_PROVIDER_DERIVED_MATCHING_POLICY_GATE";
    }
    let nextTransfer = youtubeUnavailable ? withLimitations(transfer, "YOUTUBE_GUIDED_SEARCH_FALLBACK", youtubeUnavailable) : transfer;
    if (!youtube) {
      nextTransfer = withLimitations(
        nextTransfer,
        "GUIDED_MANUAL_MATCHING_REQUIRED",
        settings.matching.riskMode === "SAFE" ? "SAFE_POLICY_GATED_MANUAL_MODE" : "RISKY_POLICY_GATED_MANUAL_MODE",
        settings.matching.reviewUncertain ? "MANUAL_REVIEW_ENABLED" : "UNCERTAIN_ITEMS_SKIP_WHEN_REVIEW_DISABLED",
      );
    }
    for (const snapshot of snapshots) {
      const tracks = Array.isArray(snapshot.snapshot.tracks) ? snapshot.snapshot.tracks : [];
      for (const [fallbackPosition, track] of tracks.entries()) {
        const position = Number.isSafeInteger(track.position) && track.position >= 0 ? track.position : fallbackPosition;
        const source = sourceReference(asProvider(transfer.sourceProvider), track);
        const hypotheses = [...buildTrackHypotheses({ titleRaw: source.titleRaw, artistRaw: source.artistRaw, channelRaw: source.channelRaw })];
        const itemId = createHash("sha256").update(`${transfer.id}:${snapshot.id}:${position}`).digest("hex").slice(0, 32);
        const existing = existingItems.get(itemId);
        if (existing && existing.state !== "PENDING") continue;
        let item: StoredItem = existing ?? {
          id: itemId,
          transferId: transfer.id,
          sourcePlaylistId: snapshot.id,
          sourcePosition: position,
          state: "PENDING",
          sourceRef: source,
          hypotheses,
          candidates: [],
          riskFlags: [],
          updatedAtMs: this.now().getTime(),
        };
        if (source.availability !== "AVAILABLE") {
          item = { ...item, state: transitionTrackItem(item.state, "SKIPPED_NOT_FOUND"), riskFlags: ["SOURCE_UNAVAILABLE"] };
          persistItem(this.database, item);
          continue;
        }
        if (!youtube) {
          const policyFlags = [
            "GUIDED_TARGET_SELECTION_REQUIRED",
            settings.matching.riskMode === "SAFE" ? "SAFE_POLICY_GATED_MANUAL_MODE" : "RISKY_POLICY_GATED_MANUAL_MODE",
            ...(youtubeUnavailable === "CROSS_PROVIDER_DERIVED_MATCHING_POLICY_GATE"
              ? ["CROSS_PROVIDER_DERIVED_SCORE_POLICY_GATE"]
              : []),
          ];
          item = settings.matching.reviewUncertain
            ? {
                ...item,
                state: transitionTrackItem(item.state, "NEEDS_REVIEW"),
                decision: { kind: "REVIEW", reason: "Policy-compliant guided candidate selection requires explicit human review" },
                riskFlags: policyFlags,
              }
            : {
                ...item,
                state: transitionTrackItem(item.state, "SKIPPED_NOT_FOUND"),
                decision: {
                  kind: "NOT_FOUND",
                  reason: settings.matching.riskMode === "SAFE"
                    ? "Safe mode skips uncertain guided matches when review is disabled"
                    : "Risky mode still cannot invent or auto-select a provider target behind the policy gate",
                },
                riskFlags: [...policyFlags, settings.matching.riskMode === "SAFE"
                  ? "SAFE_SKIPPED_UNCERTAIN_REVIEW_DISABLED"
                  : "RISKY_NO_POLICY_COMPLIANT_AUTO_CANDIDATE"],
              };
          persistItem(this.database, item);
          continue;
        }
        try {
          const queries = buildSearchQueries({ provider: "youtube", hypotheses });
          const providerCandidates: YoutubeCandidate[] = [];
          const scoreProviderCandidates = (): ScoredCandidate[] => {
            const scored: ScoredCandidate[] = [];
            for (const candidate of providerCandidates) {
              const target = youtubeTarget(candidate, this.now);
              const validation = candidateValidation(target, this.now);
              const matchInput: MatchCandidateInput = {
                target,
                validation,
                titleRaw: candidate.titleRaw,
                artistRaw: candidate.artistRaw,
                channelRaw: candidate.artistRaw,
                durationMs: candidate.durationMs,
                embeddable: candidate.embeddable,
                providerRank: candidate.searchRank,
                context: { topic: /- Topic$/i.test(candidate.artistRaw) },
              };
              for (const hypothesis of hypotheses) {
                scored.push(scoreCandidateForSource(
                  { hypothesis, durationMs: source.durationMs, isrc: source.isrc },
                  matchInput,
                ));
              }
            }
            return scored;
          };
          for (const query of queries) {
            const found = await youtube.searchCandidates(query.query, settings.matching.maxReviewCandidates);
            providerCandidates.push(...found);
            this.database.appendJournal({
              transferId: transfer.id,
              sequence: journalSequence(this.database, transfer.id),
              stepKind: "SEARCH",
              stepKey: `search:${item.id}:${query.kind}`,
              status: "COMPLETED",
              payload: { queryKind: query.kind, resultCount: found.length },
            });
            // YouTube permits one quota-bounded fallback. A merely non-empty but
            // low-confidence result set must not suppress the alternate hypothesis.
            if (decideMatch(scoreProviderCandidates(), settings.matching).kind === "HIGH_AUTO") break;
          }
          const scored = scoreProviderCandidates();
          const decision = decideMatch(scored, settings.matching);
          const allDisplay = [...scored]
            .sort((left, right) => right.score - left.score)
            .filter((candidate, index, values) => values.findIndex((other) => other.candidate.target.providerEntityId === candidate.candidate.target.providerEntityId) === index)
            .slice(0, settings.matching.maxReviewCandidates)
            .map((candidate, rank) => publicCandidate(candidate, rank + 1, decision.riskBadge));
          item = { ...item, candidates: allDisplay };
          if (decision.selected) {
            const selected = allDisplay.find((candidate) => candidate.target.providerEntityId === decision.selected!.candidate.target.providerEntityId);
            const selectionKind: MatchSelectionKind = decision.kind === "HIGH_AUTO"
              ? "MATCHED_AUTO"
              : decision.kind === "RISKY_MATCH"
                ? "RISKY_MATCH"
                : "RISKY_RELEVANCE_FALLBACK";
            item = {
              ...item,
              state: transitionTrackItem(item.state, "MATCHED_AUTO"),
              selectedTarget: {
                target: decision.selected.candidate.target,
                validation: decision.selected.candidate.validation,
                selectionKind,
                writeStrategy: "API",
              },
              decision: { kind: decision.kind, candidateId: selected?.candidateId ?? null, reason: decision.reason, decidedBy: "DETERMINISTIC_MATCHER" },
              riskFlags: decision.riskBadge ? [decision.kind] : [],
            };
          } else if (settings.matching.reviewUncertain) {
            item = { ...item, state: transitionTrackItem(item.state, "NEEDS_REVIEW"), decision: { kind: decision.kind, reason: decision.reason } };
          } else {
            item = { ...item, state: transitionTrackItem(item.state, "SKIPPED_NOT_FOUND"), decision: { kind: decision.kind, reason: decision.reason } };
          }
        } catch (error) {
          const code = error instanceof Error ? error.message : "YOUTUBE_SEARCH_FAILED";
          nextTransfer = withLimitations(nextTransfer, "YOUTUBE_SEARCH_FALLBACK_TO_GUIDED", code);
          item = settings.matching.reviewUncertain
            ? { ...item, state: transitionTrackItem(item.state, "NEEDS_REVIEW"), riskFlags: ["QUOTA_OR_ACCESS_GUIDED_FALLBACK", `${settings.matching.riskMode}_POLICY_GATED_MANUAL_MODE`] }
            : { ...item, state: transitionTrackItem(item.state, "SKIPPED_NOT_FOUND"), decision: { kind: "NOT_FOUND", reason: "Provider search unavailable and review is disabled" }, riskFlags: ["QUOTA_OR_ACCESS_GUIDED_FALLBACK", "UNCERTAIN_ITEM_SKIPPED_REVIEW_DISABLED", `${settings.matching.riskMode}_POLICY_GATED_MANUAL_MODE`] };
          if (/^(YOUTUBE_(?:GENERAL|SEARCH)_QUOTA_WAIT|YOUTUBE_QUOTA_WAIT|YOUTUBE_REAUTH_REQUIRED)$/.test(code)) {
            youtube = undefined;
            nextTransfer = {
              ...nextTransfer,
              destination: json({ ...destinationOf(nextTransfer), forceGuided: true }),
            };
          }
        }
        persistItem(this.database, item);
      }
    }
    return this.saveTransfer(nextTransfer);
  }

  private buildBlueprint(transfer: TransferRecord, items: StoredItem[]): TransferBlueprint {
    const snapshots = this.snapshots(transfer);
    const destination = destinationOf(transfer);
    const settings = transfer.settings as unknown as TransferSettings;
    const common = {
      transferId: transfer.id,
      destinationProvider: asProvider(transfer.destinationProvider),
      sources: selectedPlannerSources(
        snapshots,
        items,
        settings.destinationPrivacy === "PROVIDER_DEFAULT" ? undefined : settings.destinationPrivacy.toLowerCase(),
      ),
      settings,
      destinationMaxItems: transfer.destinationProvider === "soundcloud" ? 500 : null,
    };
    if (transfer.mode === "SEPARATE_COPY") return createTransferBlueprint({ ...common, mode: "SEPARATE_COPY" });
    if (transfer.mode === "MERGE_NEW") {
      return createTransferBlueprint({
        ...common,
        mode: "MERGE_NEW",
        mergedMetadata: { title: destination.title, description: destination.description, privacy: destination.privacy },
      });
    }
    if (!destination.providerPlaylistId) throw new Error("DESTINATION_PLAYLIST_ID_REQUIRED");
    return createTransferBlueprint({
      ...common,
      mode: "APPEND_EXISTING",
      existingDestination: {
        providerPlaylistId: destination.providerPlaylistId,
        title: destination.title,
        eligibility: destination.eligibility === "PROVIDER_VERIFIED_OWNED" ? "PROVIDER_VERIFIED_OWNED" : destination.eligibility === "UNVERIFIED_NON_OWNED" ? "UNVERIFIED_NON_OWNED" : "USER_ATTESTED_OWNED",
        existingProviderEntityIds: destination.existingItemIds,
        currentItemCount: destination.existingItemCount,
      },
    });
  }

  private bindingsFor(blueprint: TransferBlueprint, destination: DestinationState): Record<string, string> {
    return Object.fromEntries(blueprint.destinations.flatMap((entry) => {
      const id = entry.existingProviderPlaylistId ?? destination.bindings[entry.destinationPlanKey]?.providerPlaylistId;
      return id ? [[entry.destinationPlanKey, id]] : [];
    }));
  }

  private async prepareBlueprint(transfer: TransferRecord): Promise<TransferRecord> {
    const current = this.database.getTransfer(transfer.id) ?? transfer;
    const items = this.items(transfer.id);
    if (items.some((item) => item.state === "NEEDS_REVIEW")) {
      return this.updateState(current, "NEEDS_REVIEW");
    }
    if (items.length > 0 && !items.some((item) => item.selectedTarget)) {
      return this.saveTransfer({
        ...withLimitations(current, "NO_ITEMS_SELECTED_FOR_WRITE"),
        state: transitionTransfer(asTransferState(current.state), "PARTIAL"),
        completedAtMs: this.now().getTime(),
      });
    }
    const destination = destinationOf(current);
    const blueprint = destination.blueprint ?? this.buildBlueprint(current, items);
    const nextDestination = { ...destination, blueprint };
    let nextTransfer = this.saveTransfer({ ...current, destination: json(nextDestination) });
    const bindings = this.bindingsFor(blueprint, nextDestination);
    if (Object.keys(bindings).length !== blueprint.destinations.length) {
      if (nextTransfer.state === "MATCHING") nextTransfer = this.updateState(nextTransfer, "NEEDS_REVIEW");
      return nextTransfer;
    }
    const plan = materializeWritePlan(blueprint, bindings);
    this.database.transaction(() => {
      for (const item of items) {
        const planned = findPlanItem(plan, item.id);
        if (!planned) {
          if (item.state === "MATCHED_AUTO" || item.state === "USER_SELECTED") {
            persistItem(this.database, {
              ...item,
              state: transitionTrackItem(item.state, "SKIPPED_DUPLICATE"),
              riskFlags: [...new Set([...item.riskFlags, "OMITTED_DUPLICATE_BY_POLICY"])],
            });
          }
          continue;
        }
        if (item.state === "MATCHED_AUTO" || item.state === "USER_SELECTED") {
          persistItem(this.database, {
            ...item,
            state: transitionTrackItem(item.state, "WRITE_PENDING"),
            idempotencyKey: planned.idempotencyKey,
          });
        }
      }
      nextTransfer = this.saveTransfer({ ...nextTransfer, writePlan: json(plan) });
      if (nextTransfer.state === "MATCHING" || nextTransfer.state === "NEEDS_REVIEW") {
        nextTransfer = this.updateState(nextTransfer, "READY_TO_WRITE");
      }
    });
    return nextTransfer;
  }

  private async validateGuidedCandidate(
    transfer: TransferRecord,
    item: StoredItem,
    targetUrl: string,
    rank: number,
  ): Promise<StoredCandidate> {
    const connector = this.guidedConnector(asProvider(transfer.destinationProvider));
    const parsed = connector.parseUserUrl(targetUrl);
    if (parsed.entityKind === "playlist") throw new Error("TARGET_TRACK_URL_REQUIRED");
    if (parsed.containsSecretUrl) throw new Error("PRIVATE_TRACK_REQUIRES_ENCRYPTED_EXTENSION_SESSION");
    let checked: ValidationResult;
    if (parsed.provider === "youtube") {
      try {
        // An available local OAuth client validates the exact videoId with
        // videos.list (general quota) and returns unmodified provider metadata.
        checked = await this.youtubeClient().validateTargetEntity(parsed);
      } catch (error) {
        if (error instanceof Error && ["YOUTUBE_TARGET_NOT_FOUND", "YOUTUBE_NOT_FOUND"].includes(error.message)) throw error;
        checked = {
          ref: { ...parsed, validationStatus: "USER_SELECTED_UNVERIFIED" },
          evidence: {
            method: "URL_SYNTAX",
            checkedAt: this.now().getTime(),
            providerReadBack: false,
            semanticEqualityProven: false,
          },
          limitations: [
            "YOUTUBE_API_METADATA_READBACK_UNAVAILABLE",
            "URL_SYNTAX_ONLY_ENTITY_EXISTENCE_NOT_CONFIRMED",
          ],
        };
      }
    } else {
      checked = await connector.validateTargetEntity(parsed);
    }
    const target = targetReference({
      ...checked.ref,
      validationStatus: checked.evidence.providerReadBack ? "PROVIDER_VALIDATED" : "USER_SELECTED_UNVERIFIED",
    }, this.now);
    const validation: CandidateValidation = checked.evidence.providerReadBack
      ? createProviderValidation(target, {
          kind: checked.evidence.method === "OFFICIAL_API" ? "PROVIDER_API" : "PROVIDER_OEMBED",
          provider: target.provider,
          providerEntityId: target.providerEntityId,
          checkedAt: new Date(checked.evidence.checkedAt).toISOString(),
          exists: true,
          evidenceVersion: "official-oembed-or-api-v1",
        })
      : { status: "USER_SELECTED_UNVERIFIED" };
    let score = 0;
    let evidence: unknown[] = [{
      signal: "USER_URL",
      points: 0,
      detail: checked.evidence.providerReadBack
        ? "Official endpoint confirmed entity existence"
        : "Syntax-confirmed official URL; provider read-back unavailable",
    }];
    let conflicts: readonly string[] = [];
    const derivedScoringAllowed = this.allowPolicyGatedAutoMatchingForTests || (transfer.sourceProvider !== "spotify"
      && transfer.sourceProvider !== "youtube"
      && transfer.destinationProvider !== "spotify"
      && transfer.destinationProvider !== "youtube");
    if (checked.evidence.providerReadBack && derivedScoringAllowed) {
      const scored = item.hypotheses
        .map((hypothesis) => scoreCandidateForSource(
          { hypothesis, durationMs: item.sourceRef.durationMs, isrc: item.sourceRef.isrc },
          {
            target,
            validation,
            titleRaw: target.titleRaw,
            artistRaw: target.artistRaw,
            channelRaw: target.channelRaw,
            durationMs: target.durationMs,
            embeddable: target.embeddable === true,
            providerRank: rank,
            context: {},
          },
        ))
        .sort((left, right) => right.score - left.score);
      if (scored[0]) {
        score = scored[0].score;
        evidence = [...scored[0].evidence];
        conflicts = scored[0].conflicts;
      }
    } else if (!derivedScoringAllowed) {
      evidence = [{
        signal: "POLICY_GATE",
        points: 0,
        detail: "No cross-provider derived score is calculated; compare unmodified provider metadata and choose the exact ID yourself",
      }];
    }
    return {
      candidateId: randomUUID(),
      target,
      validation,
      score,
      rank,
      evidence,
      conflicts,
      riskBadge: true,
      embeddable: target.embeddable === true,
      provenance: candidateProvenance(target, validation, checked),
    };
  }

  async review(transferId: string, input: { action: "select" | "skip" | "stage-candidates"; itemId: string; target?: unknown; targets?: string[] }) {
    return this.locked(transferId, async () => {
      const transfer = this.database.getTransfer(transferId);
      if (!transfer) throw new Error("TRANSFER_NOT_FOUND");
      if (transfer.state !== "NEEDS_REVIEW") throw new Error("TRANSFER_NOT_IN_REVIEW");
      const item = this.items(transferId).find((entry) => entry.id === input.itemId);
      if (!item) throw new Error("TRANSFER_ITEM_NOT_FOUND");
      if (item.state !== "NEEDS_REVIEW" && item.state !== "SKIPPED_NOT_FOUND") throw new Error("ITEM_NOT_REVIEWABLE");
      const reviewable = item.state === "SKIPPED_NOT_FOUND" ? { ...item, state: transitionTrackItem(item.state, "NEEDS_REVIEW") } : item;
      if (input.action === "stage-candidates") {
        const urls = [...new Set((input.targets ?? []).map((url) => url.trim()).filter(Boolean))];
        if (urls.length < 3 || urls.length > 5) throw new Error("THREE_TO_FIVE_CANDIDATE_URLS_REQUIRED");
        const candidates: StoredCandidate[] = [];
        for (const [index, url] of urls.entries()) candidates.push(await this.validateGuidedCandidate(transfer, reviewable, url, index + 1));
        const uniqueCandidates = candidates.filter((candidate, index, all) => all.findIndex((other) => other.target.providerEntityId === candidate.target.providerEntityId) === index);
        if (uniqueCandidates.length < 3) throw new Error("THREE_DISTINCT_CANDIDATE_IDS_REQUIRED");
        persistItem(this.database, { ...reviewable, candidates: uniqueCandidates });
        this.database.appendJournal({
          transferId,
          sequence: journalSequence(this.database, transferId),
          stepKind: "REVIEW_CANDIDATES",
          stepKey: `review-candidates:${item.id}`,
          status: "COMPLETED",
          payload: { candidateCount: uniqueCandidates.length, providerReadBackCount: uniqueCandidates.filter((candidate) => candidate.validation.status === "PROVIDER_VALIDATED").length },
        });
        return this.view(transferId);
      }
      if (input.action === "skip") {
        const skipped = { ...reviewable, state: transitionTrackItem(reviewable.state, "SKIPPED_NOT_FOUND"), decision: { kind: "SKIPPED", actor: "USER", decidedAt: iso(this.now) } };
        persistItem(this.database, skipped);
        this.database.saveReviewDecision(item.id, skipped.decision!);
      } else {
        let chosen: StoredCandidate | undefined;
        const value = typeof input.target === "object" && input.target ? input.target as Record<string, unknown> : {};
        const nestedTarget = value.target && typeof value.target === "object" ? value.target as Record<string, unknown> : undefined;
        const candidateId = typeof value.candidateId === "string" ? value.candidateId : typeof input.target === "string" && !/^https:\/\//.test(input.target) ? input.target : undefined;
        const providerEntityId = typeof value.providerEntityId === "string" ? value.providerEntityId : typeof nestedTarget?.providerEntityId === "string" ? nestedTarget.providerEntityId : undefined;
        if (candidateId) chosen = item.candidates.find((candidate) => candidate.candidateId === candidateId);
        if (!chosen && providerEntityId) chosen = item.candidates.find((candidate) => candidate.target.providerEntityId === providerEntityId);
        let target: ProviderTrackReference;
        let validation: CandidateValidation;
        if (chosen) {
          target = chosen.target;
          validation = chosen.validation;
        } else {
          const targetUrl = typeof input.target === "string"
            ? input.target
            : typeof value.url === "string"
              ? value.url
              : typeof value.providerUriOrUrl === "string"
                ? value.providerUriOrUrl
                : typeof nestedTarget?.providerUriOrUrl === "string"
                  ? nestedTarget.providerUriOrUrl
                  : undefined;
          if (!targetUrl) throw new Error("TARGET_URL_OR_CANDIDATE_REQUIRED");
          chosen = await this.validateGuidedCandidate(transfer, item, targetUrl, item.candidates.length + 1);
          target = chosen.target;
          validation = chosen.validation;
        }
        const canApiWrite = transfer.destinationProvider === "youtube"
          && !destinationOf(transfer).forceGuided
          && validation.status === "PROVIDER_VALIDATED"
          && (() => { try { this.youtubeClient(); return true; } catch { return false; } })();
        const matchingSettings = (transfer.settings as unknown as TransferSettings).matching;
        const selected = {
          ...reviewable,
          state: transitionTrackItem(reviewable.state, "USER_SELECTED"),
          candidates: item.candidates.some((candidate) => candidate.candidateId === chosen!.candidateId) ? item.candidates : [...item.candidates, chosen],
          selectedTarget: { target, validation, selectionKind: "USER_SELECTED" as const, writeStrategy: canApiWrite ? "API" as const : "GUIDED_USER_ACTION" as const },
          decision: { kind: "SELECTED", actor: "USER", candidateId: chosen.candidateId, decidedAt: iso(this.now), providerReadBack: validation.status === "PROVIDER_VALIDATED" },
          riskFlags: chosen.riskBadge
            ? [...new Set([...item.riskFlags, matchingSettings.riskMode === "RISKY" ? "RISKY_USER_SELECTED" : "SAFE_HUMAN_OVERRIDE"])]
            : item.riskFlags,
        };
        persistItem(this.database, selected);
        this.database.saveReviewDecision(item.id, selected.decision!);
      }
      await this.prepareBlueprint(this.database.getTransfer(transferId)!);
      return this.view(transferId);
    });
  }

  async bindDestination(transferId: string, input: {
    planKey: string;
    playlistUrl: string;
    title?: string;
    ownershipAttested: boolean;
    editControlAttested: boolean;
    newPlaylistAttested: boolean;
    visibleItemCount: number;
  }) {
    return this.locked(transferId, async () => {
      const transfer = this.database.getTransfer(transferId);
      if (!transfer) throw new Error("TRANSFER_NOT_FOUND");
      if (transfer.writePlan) throw new Error("WRITE_PLAN_ALREADY_IMMUTABLE");
      if (!input.ownershipAttested || !input.editControlAttested) throw new Error("DESTINATION_OWNER_AND_EDIT_ATTESTATION_REQUIRED");
      if (transfer.mode === "APPEND_EXISTING") throw new Error("APPEND_EXISTING_DESTINATION_MUST_BE_BOUND_AT_CREATION");
      if (!input.newPlaylistAttested) throw new Error("NEW_DESTINATION_CREATION_ATTESTATION_REQUIRED");
      if (!Number.isSafeInteger(input.visibleItemCount) || input.visibleItemCount !== 0) {
        throw new Error("NEW_DESTINATION_MUST_BE_EMPTY_AT_BINDING");
      }
      const destination = destinationOf(transfer);
      const blueprint = destination.blueprint;
      if (!blueprint) throw new Error("DESTINATION_BLUEPRINT_NOT_READY");
      const targetPlan = blueprint.destinations.find((entry) => entry.destinationPlanKey === input.planKey && !entry.existingProviderPlaylistId);
      if (!targetPlan) throw new Error("DESTINATION_PLAN_KEY_NOT_FOUND");
      const parsed = safePlaylistId(asProvider(transfer.destinationProvider), input.playlistUrl);
      if (transfer.mode === "SEPARATE_COPY" && Object.entries(destination.bindings).some(
        ([planKey, binding]) => planKey !== input.planKey && binding.providerPlaylistId === parsed.id,
      )) {
        throw new Error("SEPARATE_COPY_DESTINATION_MUST_BE_UNIQUE_PER_SOURCE");
      }
      const bindings = {
        ...destination.bindings,
        [input.planKey]: {
          providerPlaylistId: parsed.id,
          playlistUrl: parsed.url,
          title: input.title?.trim() || targetPlan.metadata.title,
          eligibility: "USER_ATTESTED_OWNED" as const,
          newPlaylistAttested: true as const,
          initialVisibleItemCount: 0 as const,
          boundAtMs: this.now().getTime(),
        },
      };
      this.saveTransfer({ ...transfer, destination: json({ ...destination, bindings }) });
      await this.prepareBlueprint(this.database.getTransfer(transferId)!);
      this.database.audit("NEW_EMPTY_DESTINATION_BOUND_BY_USER", transferId, {
        planKey: input.planKey,
        provider: transfer.destinationProvider,
        eligibility: "USER_ATTESTED_OWNED",
        ownerControlAttested: true,
        editControlAttested: true,
        newPlaylistAttested: true,
        visibleItemCount: 0,
        existingDestinationAccepted: false,
      });
      return this.view(transferId);
    });
  }

  private pendingGuidedAction(transferId: string, itemId: string): GuidedAction | undefined {
    const entry = this.database.listJournal(transferId).find((row) => row.stepKey === `guided:${itemId}` && row.status === "AWAITING_USER");
    return entry ? (entry.payload as JsonObject).action as GuidedAction | undefined : undefined;
  }

  private async issueGuidedAction(transfer: TransferRecord, item: StoredItem, plan: ImmutableWritePlan) {
    if (!item.selectedTarget) throw new Error("SELECTED_TARGET_REQUIRED");
    const planned = findPlanItem(plan, item.id);
    if (!planned) throw new Error("PLANNED_ITEM_NOT_FOUND");
    const journalEntry = this.database.listJournal(transfer.id).find((row) => row.stepKey === `guided:${item.id}`);
    const current = this.pendingGuidedAction(transfer.id, item.id);
    if (current) {
      if (item.state === "WRITE_PENDING") {
        persistItem(this.database, { ...item, state: transitionTrackItem(item.state, "AWAITING_USER_RECONCILIATION") });
      }
      return current;
    }
    const connector = this.guidedConnector(asProvider(transfer.destinationProvider));
    const ref = parseProviderUrl(asProvider(transfer.destinationProvider), item.selectedTarget.target.providerUriOrUrl);
    const destination = destinationOf(transfer);
    const binding = Object.values(destination.bindings).find((value) => value.providerPlaylistId === planned.destinationPlaylistId);
    const baseAction = connector.buildAddAction(ref, {
      id: planned.destinationPlaylistId,
      url: binding?.playlistUrl ?? destination.playlistUrl,
      label: binding?.title ?? destination.title,
    });
    const requiresFreshDestinationConfirmation = true;
    const destinationReceipts = this.database.listReceipts(transfer.id)
      .filter((receipt) => receipt.destinationPlaylistId === planned.destinationPlaylistId);
    const baselineAmbiguous = destinationReceipts.some((receipt) => receipt.verificationStatus === "WRITE_UNVERIFIED");
    const confirmedStatuses = new Set(["VERIFIED_PROVIDER", "USER_CONFIRMED_MANUAL", "WRITE_CONFIRMED_NON_OWNED"]);
    const knownAdds = destinationReceipts.filter((receipt) => confirmedStatuses.has(String(receipt.verificationStatus))).length;
    const destinationBaselineKind = transfer.mode === "APPEND_EXISTING" ? "EXISTING_SNAPSHOT" as const : "NEW_EMPTY_AT_BINDING" as const;
    const initialDestinationItemCount = transfer.mode === "APPEND_EXISTING" ? destination.existingItemCount : 0;
    const expectedDestinationItemCount = !baselineAmbiguous
      ? initialDestinationItemCount + knownAdds
      : undefined;
    const freshnessInstructions = [
      expectedDestinationItemCount === undefined
        ? "Refresh the official destination now and confirm its current count; an earlier result was unverified, so do not assume a baseline count."
        : `Refresh the official destination now and confirm the visible item count is exactly ${expectedDestinationItemCount} (${destinationBaselineKind === "NEW_EMPTY_AT_BINDING" ? "new empty baseline" : "existing snapshot baseline"} plus ${knownAdds} confirmed transfer adds).`,
      "Confirm the destination identity and re-check that the exact target is allowed by the selected collision policy. If anything differs, do not add; cancel and create a fresh transfer snapshot.",
    ];
    const action: GuidedAction = {
      ...baseAction,
      instructions: [...freshnessInstructions, ...baseAction.instructions],
      requiresFreshDestinationConfirmation,
      expectedDestinationItemCount,
      destinationSnapshotVersion: destination.destinationSnapshotVersion,
      baselineAmbiguous,
      destinationBaselineKind,
      confirmedPriorAdds: knownAdds,
      expectedManualActions: baseAction.expectedManualActions + freshnessInstructions.length,
    };
    const issuedAt = iso(this.now);
    const leaseContext = this.leaseContexts.get(transfer.id);
    if (!leaseContext || !this.renewLease(transfer.id)) throw new Error("TRANSFER_LEASE_LOST");
    this.database.transaction(() => {
      this.database.appendJournal({
        transferId: transfer.id,
        sequence: Number(journalEntry?.sequence ?? journalSequence(this.database, transfer.id)),
        stepKind: "GUIDED_ADD",
        stepKey: `guided:${item.id}`,
        status: "AWAITING_USER",
        payload: {
          action,
          issuedAt,
          destinationPlaylistId: planned.destinationPlaylistId,
          idempotencyKey: planned.idempotencyKey,
          resourceLeaseOwnerId: leaseContext.resourceOwnerId,
          priorOutcome: journalEntry?.status === "CONFIRMED_ABSENT_RETRY_ALLOWED" ? journalEntry.payload : undefined,
        },
        attempt: Number(journalEntry?.attempt ?? 0),
      });
      persistItem(this.database, { ...item, state: transitionTrackItem(item.state, "AWAITING_USER_RECONCILIATION") });
    });
    return action;
  }

  private async completeApiWrite(transfer: TransferRecord, item: StoredItem, plan: ImmutableWritePlan) {
    const planned = findPlanItem(plan, item.id);
    if (!planned || !item.selectedTarget || !item.idempotencyKey) throw new Error("PLANNED_ITEM_NOT_FOUND");
    const target = item.selectedTarget.target;
    if (target.provider !== "youtube" || !target.videoId) throw new Error("YOUTUBE_VIDEO_ID_REQUIRED");
    const fallbackBeforeMutation = async (code: string) => {
      const guidedItem: StoredItem = {
        ...item,
        selectedTarget: { ...item.selectedTarget!, writeStrategy: "GUIDED_USER_ACTION" },
        riskFlags: [...new Set([...item.riskFlags, code, "API_TO_GUIDED_BEFORE_MUTATION"])],
      };
      persistItem(this.database, guidedItem);
      this.saveTransfer(withLimitations({
        ...transfer,
        destination: json({ ...destinationOf(transfer), forceGuided: true }),
      }, "YOUTUBE_API_UNAVAILABLE_GUIDED_FALLBACK", code));
      const action = await this.issueGuidedAction(this.database.getTransfer(transfer.id)!, guidedItem, plan);
      return { completed: false, action, error: code, providerMutationPerformed: false };
    };
    let youtube: YoutubeApiClient;
    try {
      youtube = this.youtubeClient();
    } catch (error) {
      return fallbackBeforeMutation(error instanceof Error ? error.message : "YOUTUBE_API_NOT_CONNECTED");
    }
    const stepKey = `api:${item.id}`;
    const previous = this.database.listJournal(transfer.id).find((entry) => entry.stepKey === stepKey);
    let issuedAt = typeof (previous?.payload as JsonObject | undefined)?.issuedAt === "string" ? String((previous!.payload as JsonObject).issuedAt) : iso(this.now);
    const beforeCount = Number((previous?.payload as JsonObject | undefined)?.beforeTargetCount ?? -1);
    if (previous?.status === "RUNNING" && beforeCount >= 0) {
      let recovery: Awaited<ReturnType<YoutubeApiClient["verifyPlaylist"]>> | undefined;
      try {
        if (!this.renewLease(transfer.id)) throw new Error("TRANSFER_LEASE_LOST");
        recovery = await youtube.verifyPlaylist(planned.destinationPlaylistId, []);
      } catch (error) {
        if (error instanceof Error && error.message === "TRANSFER_LEASE_LOST") throw error;
        // A prior append may have reached YouTube. Without read-back, only user reconciliation is safe.
      }
      if (!recovery) {
        const pending = { ...item, state: transitionTrackItem(item.state, "AWAITING_USER_RECONCILIATION"), riskFlags: [...new Set([...item.riskFlags, "AMBIGUOUS_API_RESULT", "RECOVERY_READ_UNAVAILABLE"])] };
        const action = await this.issueReconciliationAction(transfer, pending, planned.destinationPlaylistId, issuedAt);
        return { completed: false, action, error: "RECOVERY_READ_UNAVAILABLE" };
      }
      if (countById(recovery.actualVideoIds, target.videoId) > beforeCount) {
        const receipt = createProviderVerifiedReceipt(
          baseReceipt(item, transfer.id, planned.destinationPlaylistId, issuedAt),
          item.selectedTarget.validation,
          {
            kind: "API_READ_AFTER_WRITE",
            provider: "youtube",
            destinationPlaylistId: planned.destinationPlaylistId,
            checkedAt: new Date(Math.max(recovery.checkedAt, Date.parse(issuedAt))).toISOString(),
            observedProviderEntityIds: recovery.actualVideoIds,
            evidenceVersion: "youtube-playlistItems-v3-recovery",
          },
        );
        const written = { ...item, state: transitionTrackItem(item.state, "WRITTEN") };
        this.database.transaction(() => {
          saveReceipt(this.database, item, receipt, item.riskFlags.length > 0);
          persistItem(this.database, written);
          persistItem(this.database, { ...written, state: transitionTrackItem(written.state, "VERIFIED_PROVIDER", { receipt }) });
          this.database.appendJournal({ transferId: transfer.id, sequence: Number(previous.sequence), stepKind: "API_ADD", stepKey, status: "COMPLETED", payload: { recoveredByReadBack: true, beforeTargetCount: beforeCount } });
        });
        return { completed: true, recovered: true };
      }
      const pending = { ...item, state: transitionTrackItem(item.state, "AWAITING_USER_RECONCILIATION"), riskFlags: [...new Set([...item.riskFlags, "AMBIGUOUS_API_RESULT"])] };
      const action = await this.issueReconciliationAction(transfer, pending, planned.destinationPlaylistId, issuedAt);
      return { completed: false, action };
    }
    let before: Awaited<ReturnType<YoutubeApiClient["verifyPlaylist"]>>;
    try {
      if (!this.renewLease(transfer.id)) throw new Error("TRANSFER_LEASE_LOST");
      before = await youtube.verifyPlaylist(planned.destinationPlaylistId, []);
    } catch (error) {
      const code = error instanceof Error ? error.message : "YOUTUBE_PREWRITE_READ_FAILED";
      if (code === "TRANSFER_LEASE_LOST") throw error;
      return fallbackBeforeMutation(code);
    }
    const initialCount = countById(before.actualVideoIds, target.videoId);
    const destination = destinationOf(transfer);
    const priorSuccessfulTargets = this.database.listReceipts(transfer.id)
      .filter((receipt) => receipt.destinationPlaylistId === planned.destinationPlaylistId
        && (receipt.verificationStatus === "VERIFIED_PROVIDER" || receipt.verificationStatus === "USER_CONFIRMED_MANUAL"))
      .map((receipt) => String(receipt.targetEntityId));
    const expectedBefore = [...destination.existingItemIds, ...priorSuccessfulTargets];
    if (before.actualVideoIds.length !== expectedBefore.length
      || before.actualVideoIds.some((id, index) => id !== expectedBefore[index])) {
      this.saveTransfer(withLimitations(transfer, "YOUTUBE_DESTINATION_CHANGED_AFTER_PLAN_RESTART_REQUIRED"));
      this.database.appendJournal({
        transferId: transfer.id,
        sequence: journalSequence(this.database, transfer.id),
        stepKind: "CONCURRENT_EDIT_GUARD",
        stepKey: `concurrent-edit:${item.id}`,
        status: "BLOCKED_BEFORE_MUTATION",
        payload: {
          expectedCount: expectedBefore.length,
          actualCount: before.actualVideoIds.length,
          checkedAt: before.checkedAt,
          providerMutationPerformed: false,
          rawProviderIdsPersisted: false,
        },
      });
      throw new Error("YOUTUBE_DESTINATION_CHANGED_AFTER_PLAN_RESTART_REQUIRED");
    }
    issuedAt = iso(this.now);
    this.database.appendJournal({
      transferId: transfer.id,
      sequence: journalSequence(this.database, transfer.id),
      stepKind: "API_ADD",
      stepKey,
      status: "RUNNING",
      payload: {
        issuedAt,
        destinationPlaylistId: planned.destinationPlaylistId,
        targetEntityId: target.videoId,
        beforeTargetCount: initialCount,
        idempotencyKey: planned.idempotencyKey,
      },
    });
    let appendAcknowledged = false;
    try {
      if (!this.renewLease(transfer.id)) throw new Error("TRANSFER_LEASE_LOST");
      await youtube.appendItem(planned.destinationPlaylistId, target.videoId);
      appendAcknowledged = true;
      const after = await youtube.verifyPlaylist(planned.destinationPlaylistId, []);
      if (countById(after.actualVideoIds, target.videoId) <= initialCount) throw new Error("YOUTUBE_WRITE_NOT_OBSERVED_AFTER_APPEND");
      const receipt = createProviderVerifiedReceipt(
        baseReceipt(item, transfer.id, planned.destinationPlaylistId, issuedAt),
        item.selectedTarget.validation,
        {
          kind: "API_READ_AFTER_WRITE",
          provider: "youtube",
          destinationPlaylistId: planned.destinationPlaylistId,
          checkedAt: new Date(Math.max(after.checkedAt, Date.parse(issuedAt))).toISOString(),
          observedProviderEntityIds: after.actualVideoIds,
          evidenceVersion: "youtube-playlistItems-v3",
        },
      );
      const written = { ...item, state: transitionTrackItem(item.state, "WRITTEN") };
      this.database.transaction(() => {
        saveReceipt(this.database, item, receipt, item.riskFlags.length > 0);
        persistItem(this.database, written);
        persistItem(this.database, { ...written, state: transitionTrackItem(written.state, "VERIFIED_PROVIDER", { receipt }) });
        this.database.appendJournal({ transferId: transfer.id, sequence: journalSequence(this.database, transfer.id), stepKind: "API_ADD", stepKey, status: "COMPLETED", payload: { issuedAt, beforeTargetCount: initialCount, verifiedAt: after.checkedAt } });
      });
      return { completed: true };
    } catch (error) {
      const code = error instanceof Error ? error.message : "YOUTUBE_API_WRITE_FAILED";
      if (code === "TRANSFER_LEASE_LOST") throw error;
      const providerMutationMayHaveStarted = (error as { providerMutationMayHaveStarted?: boolean } | undefined)?.providerMutationMayHaveStarted;
      if (!appendAcknowledged && providerMutationMayHaveStarted === false
        && /^(YOUTUBE_(?:GENERAL|SEARCH)_QUOTA_WAIT|YOUTUBE_QUOTA_WAIT|YOUTUBE_REAUTH_REQUIRED)$/.test(code)) {
        this.database.appendJournal({
          transferId: transfer.id,
          sequence: journalSequence(this.database, transfer.id),
          stepKind: "API_ADD",
          stepKey,
          status: "FAILED_BEFORE_MUTATION",
          payload: { issuedAt, beforeTargetCount: initialCount, error: code, providerMutationPerformed: false },
        });
        return fallbackBeforeMutation(code);
      }
      let after: Awaited<ReturnType<YoutubeApiClient["verifyPlaylist"]>> | undefined;
      try { after = await youtube.verifyPlaylist(planned.destinationPlaylistId, []); } catch { /* provider read-back unavailable */ }
      if (after && countById(after.actualVideoIds, target.videoId) > initialCount) {
        const receipt = createProviderVerifiedReceipt(
          baseReceipt(item, transfer.id, planned.destinationPlaylistId, issuedAt),
          item.selectedTarget.validation,
          { kind: "API_READ_AFTER_WRITE", provider: "youtube", destinationPlaylistId: planned.destinationPlaylistId, checkedAt: new Date(Math.max(after.checkedAt, Date.parse(issuedAt))).toISOString(), observedProviderEntityIds: after.actualVideoIds, evidenceVersion: "youtube-playlistItems-v3-error-recovery" },
        );
        const written = { ...item, state: transitionTrackItem(item.state, "WRITTEN") };
        this.database.transaction(() => {
          saveReceipt(this.database, item, receipt, item.riskFlags.length > 0);
          persistItem(this.database, written);
          persistItem(this.database, { ...written, state: transitionTrackItem(written.state, "VERIFIED_PROVIDER", { receipt }) });
          this.database.appendJournal({ transferId: transfer.id, sequence: journalSequence(this.database, transfer.id), stepKind: "API_ADD", stepKey, status: "COMPLETED", payload: { recoveredAfterError: code, beforeTargetCount: initialCount } });
        });
        return { completed: true, recovered: true };
      }
      const pending = { ...item, state: transitionTrackItem(item.state, "AWAITING_USER_RECONCILIATION"), riskFlags: [...new Set([...item.riskFlags, code, "API_TO_GUIDED_RECONCILIATION"])] };
      const action = await this.issueReconciliationAction(transfer, pending, planned.destinationPlaylistId, issuedAt);
      return { completed: false, action, error: code };
    }
  }

  private async issueReconciliationAction(transfer: TransferRecord, item: StoredItem, destinationPlaylistId: string, issuedAt: string) {
    if (!item.selectedTarget || !item.idempotencyKey) throw new Error("WRITE_PLAN_ITEM_INCOMPLETE");
    const destination = destinationOf(transfer);
    const binding = Object.values(destination.bindings)
      .find((candidate) => candidate.providerPlaylistId === destinationPlaylistId);
    const canonicalUrl = transfer.destinationProvider === "youtube"
      ? `https://www.youtube.com/playlist?list=${encodeURIComponent(destinationPlaylistId)}`
      : transfer.destinationProvider === "spotify"
        ? `https://open.spotify.com/playlist/${encodeURIComponent(destinationPlaylistId)}`
        : undefined;
    const action: GuidedAction = {
      id: randomUUID(),
      provider: asProvider(transfer.destinationProvider),
      kind: "VERIFY_ITEM",
      title: "Reconcile before any retry",
      instructions: [
        "Open the official destination playlist.",
        "Check the exact target occurrence. Do not add it again during this check.",
        "Return and choose present, absent, or unknown. Only an explicit absent answer permits a later retry.",
      ],
      openUrl: binding?.playlistUrl ?? destination.playlistUrl ?? canonicalUrl,
      targetEntityId: item.selectedTarget.target.providerEntityId,
      destinationLabel: binding?.title ?? destination.title,
      expectedManualActions: 3,
      automation: "USER_OPERATED",
    };
    const existing = this.database.listJournal(transfer.id).find((entry) => entry.stepKey === `guided:${item.id}`);
    const leaseContext = this.leaseContexts.get(transfer.id);
    if (!leaseContext || !this.renewLease(transfer.id)) throw new Error("TRANSFER_LEASE_LOST");
    this.database.transaction(() => {
      persistItem(this.database, item);
      this.database.appendJournal({
        transferId: transfer.id,
        sequence: Number(existing?.sequence ?? journalSequence(this.database, transfer.id)),
        stepKind: "RECONCILIATION",
        stepKey: `guided:${item.id}`,
        status: "AWAITING_USER",
        payload: {
          action,
          issuedAt,
          destinationPlaylistId,
          idempotencyKey: item.idempotencyKey,
          ambiguousApi: true,
          resourceLeaseOwnerId: leaseContext.resourceOwnerId,
        },
        attempt: Number(existing?.attempt ?? 0),
      });
    });
    return action;
  }

  private async createNextApiDestination(transfer: TransferRecord): Promise<boolean> {
    const destination = destinationOf(transfer);
    const blueprint = destination.blueprint;
    if (!blueprint || transfer.destinationProvider !== "youtube" || destination.forceGuided) return false;
    const unbound = blueprint.destinations.find((entry) => !entry.existingProviderPlaylistId && !destination.bindings[entry.destinationPlanKey]);
    if (!unbound) return false;
    const stepKey = `create:${unbound.destinationPlanKey}`;
    const previous = this.database.listJournal(transfer.id).find((entry) => entry.stepKey === stepKey);
    const previousPayload = (previous?.payload ?? {}) as JsonObject;
    if (previous?.status === "COMPLETED" && typeof previousPayload.destinationPlaylistId === "string") {
      const bindings = {
        ...destination.bindings,
        [unbound.destinationPlanKey]: {
          providerPlaylistId: previousPayload.destinationPlaylistId,
          playlistUrl: typeof previousPayload.playlistUrl === "string" ? previousPayload.playlistUrl : undefined,
          title: unbound.metadata.title,
        },
      };
      this.saveTransfer({ ...transfer, destination: json({ ...destination, bindings }) });
      await this.prepareBlueprint(this.database.getTransfer(transfer.id)!);
      return true;
    }
    if (previous && previous.status !== "CONFIRMED_ABSENT_RETRY_ALLOWED") {
      this.database.appendJournal({
        transferId: transfer.id,
        sequence: Number(previous.sequence),
        stepKind: "CREATE_PLAYLIST",
        stepKey,
        status: "AMBIGUOUS_REQUIRES_USER_BINDING",
        payload: { ...previousPayload, blindRetrySuppressed: true },
        attempt: Number(previous.attempt ?? 0),
      });
      this.saveTransfer(withLimitations(transfer, "AMBIGUOUS_DESTINATION_CREATE_REQUIRES_BINDING"));
      return false;
    }
    const issuedAt = iso(this.now);
    this.database.appendJournal({
      transferId: transfer.id,
      sequence: journalSequence(this.database, transfer.id),
      stepKind: "CREATE_PLAYLIST",
      stepKey,
      status: "RUNNING",
      payload: { provider: "youtube", title: unbound.metadata.title, issuedAt, providerMutationMayHaveStarted: true },
    });
    const youtube = this.youtubeClient();
    const privacy = unbound.metadata.privacy === "public" || unbound.metadata.privacy === "unlisted" ? unbound.metadata.privacy : "private";
    try {
      if (!this.renewLease(transfer.id)) throw new Error("TRANSFER_LEASE_LOST");
      const created = await youtube.createPlaylist({ title: unbound.metadata.title, description: unbound.metadata.description, privacyStatus: privacy });
      const bindings = { ...destination.bindings, [unbound.destinationPlanKey]: { providerPlaylistId: created.id, playlistUrl: created.url, title: unbound.metadata.title } };
      this.database.transaction(() => {
        this.saveTransfer({ ...transfer, destination: json({ ...destination, bindings }) });
        this.database.appendJournal({
          transferId: transfer.id,
          sequence: journalSequence(this.database, transfer.id),
          stepKind: "CREATE_PLAYLIST",
          stepKey,
          status: "COMPLETED",
          payload: { provider: "youtube", destinationPlaylistId: created.id, playlistUrl: created.url, issuedAt },
        });
      });
      await this.prepareBlueprint(this.database.getTransfer(transfer.id)!);
      return true;
    } catch (error) {
      const code = error instanceof Error ? error.message : "DESTINATION_CREATE_FAILED";
      if (code === "TRANSFER_LEASE_LOST") throw error;
      try {
        this.database.appendJournal({
          transferId: transfer.id,
          sequence: Number(previous?.sequence ?? journalSequence(this.database, transfer.id)),
          stepKind: "CREATE_PLAYLIST",
          stepKey,
          status: "AMBIGUOUS_REQUIRES_USER_BINDING",
          payload: { provider: "youtube", title: unbound.metadata.title, issuedAt, error: code, blindRetrySuppressed: true },
          attempt: Number(previous?.attempt ?? 0) + 1,
        });
        this.saveTransfer(withLimitations(transfer, "AMBIGUOUS_DESTINATION_CREATE_REQUIRES_BINDING", code));
      } catch {
        // The durable RUNNING marker still prevents a blind retry after a storage failure.
      }
      return false;
    }
  }

  async runNext(transferId: string) {
    return this.locked(transferId, async () => {
      let transfer = this.database.getTransfer(transferId);
      if (!transfer) throw new Error("TRANSFER_NOT_FOUND");
      if (transfer.state === "DRAFT") throw new Error("START_REQUIRED");
      if (transfer.state === "NEEDS_REVIEW" && !transfer.writePlan) {
        const items = this.items(transferId);
        if (items.some((item) => item.state === "NEEDS_REVIEW")) return this.view(transferId);
        try {
          if (await this.createNextApiDestination(transfer)) return this.view(transferId);
        } catch (error) {
          transfer = this.saveTransfer(withLimitations(transfer, "DESTINATION_API_CREATE_UNAVAILABLE_GUIDED_BIND_REQUIRED", error instanceof Error ? error.message : "DESTINATION_CREATE_FAILED"));
          return this.view(transferId);
        }
        await this.prepareBlueprint(transfer);
        transfer = this.database.getTransfer(transferId)!;
        if (!transfer.writePlan) return this.view(transferId);
      }
      if (transfer.state === "NEEDS_REVIEW" && transfer.writePlan
        && !this.items(transferId).some((item) => item.state === "NEEDS_REVIEW")) {
        // Repair the only historic half-state possible before plan+READY became atomic.
        transfer = this.updateState(transfer, "READY_TO_WRITE");
      }
      if (transfer.state === "READY_TO_WRITE") transfer = this.updateState(transfer, "WRITING");
      if (transfer.state !== "WRITING") return this.view(transferId);
      const plan = transfer.writePlan as unknown as ImmutableWritePlan;
      let items = this.items(transferId);
      const receiptsByKey = new Map(this.database.listReceipts(transferId).map((receipt) => [receipt.idempotencyKey, receipt]));
      for (const candidate of items) {
        const stored = candidate.idempotencyKey ? receiptsByKey.get(candidate.idempotencyKey) : undefined;
        const receipt = stored ? (stored.evidence as JsonObject).domainReceipt as WriteReceipt | undefined : undefined;
        if (!receipt || !["VERIFIED_PROVIDER", "USER_CONFIRMED_MANUAL", "WRITE_CONFIRMED_NON_OWNED", "WRITE_UNVERIFIED"].includes(receipt.verificationStatus)) continue;
        this.database.transaction(() => {
          let recovered = candidate;
          if (recovered.state === "WRITE_PENDING") {
            recovered = { ...recovered, state: transitionTrackItem(recovered.state, "WRITTEN") };
            persistItem(this.database, recovered);
          }
          if (recovered.state === "WRITTEN") {
            persistItem(this.database, {
              ...recovered,
              state: transitionTrackItem(recovered.state, receipt.verificationStatus, { receipt }),
            });
          } else if (recovered.state === "AWAITING_USER_RECONCILIATION"
            && (receipt.verificationStatus === "USER_CONFIRMED_MANUAL" || receipt.verificationStatus === "WRITE_UNVERIFIED")) {
            persistItem(this.database, {
              ...recovered,
              state: transitionTrackItem(recovered.state, receipt.verificationStatus, { receipt }),
            });
          }
        });
      }
      items = this.items(transferId);
      const awaiting = items.find((item) => item.state === "AWAITING_USER_RECONCILIATION");
      if (awaiting) return this.view(transferId);
      const item = plan.destinations
        .flatMap((destinationPlan) => destinationPlan.items)
        .map((plannedItem) => items.find((entry) => entry.id === plannedItem.sourceItemId))
        .find((entry): entry is StoredItem => Boolean(entry && entry.state === "WRITE_PENDING"));
      if (!item) {
        this.finish(transfer);
        return this.view(transferId);
      }
      if (item.selectedTarget?.writeStrategy === "API" && !destinationOf(transfer).forceGuided) await this.completeApiWrite(transfer, item, plan);
      else await this.issueGuidedAction(transfer, item, plan);
      const refreshed = this.database.getTransfer(transferId)!;
      if (!this.items(transferId).some((entry) => ACTIVE_ITEM_STATES.has(entry.state))) this.finish(refreshed);
      return this.view(transferId);
    });
  }

  async reconcile(transferId: string, input: { itemId: string; result: ReconciliationResult }) {
    return this.locked(transferId, async () => {
      const transfer = this.database.getTransfer(transferId);
      if (!transfer) throw new Error("TRANSFER_NOT_FOUND");
      const item = this.items(transferId).find((entry) => entry.id === input.itemId);
      if (!item) throw new Error("TRANSFER_ITEM_NOT_FOUND");
      if (item.state !== "AWAITING_USER_RECONCILIATION") throw new Error("ITEM_NOT_AWAITING_RECONCILIATION");
      const journal = this.database.listJournal(transferId).find((entry) => entry.stepKey === `guided:${item.id}` && entry.status === "AWAITING_USER");
      if (!journal) throw new Error("RECONCILIATION_ACTION_NOT_FOUND");
      const payload = journal.payload as JsonObject;
      const destinationPlaylistId = requiredText(payload.destinationPlaylistId, "DESTINATION_PLAYLIST_ID_REQUIRED");
      const issuedAt = requiredText(payload.issuedAt, "GUIDED_ACTION_TIMESTAMP_REQUIRED");
      if (input.result === "absent") {
        this.database.transaction(() => {
          persistItem(this.database, { ...item, state: transitionTrackItem(item.state, "WRITE_PENDING") });
          this.database.appendJournal({
            transferId,
            sequence: Number(journal.sequence),
            stepKind: String(journal.stepKind),
            stepKey: `guided:${item.id}`,
            status: "CONFIRMED_ABSENT_RETRY_ALLOWED",
            payload: {
              ...payload,
              reconciledAt: iso(this.now),
              previousActionId: (payload.action as JsonObject | undefined)?.id ?? null,
              resourceLeaseOwnerId: undefined,
            },
            attempt: Number(journal.attempt ?? 0) + 1,
          });
        });
      } else {
        const base = baseReceipt(item, transferId, destinationPlaylistId, issuedAt);
        const receipt = input.result === "present"
          ? createUserConfirmedManualReceipt(base, { kind: "USER_DESTINATION_CONFIRMATION", provider: asProvider(transfer.destinationProvider), destinationPlaylistId, providerEntityId: item.selectedTarget!.target.providerEntityId, confirmedAt: iso(this.now), userAttestedPresent: true })
          : createUnverifiedReceipt(base, "User could not determine whether the guided/API action changed the destination");
        this.database.transaction(() => {
          saveReceipt(this.database, item, receipt, item.riskFlags.length > 0);
          persistItem(this.database, { ...item, state: transitionTrackItem(item.state, receipt.verificationStatus, { receipt }) });
          this.database.appendJournal({
            transferId,
            sequence: Number(journal.sequence),
            stepKind: String(journal.stepKind),
            stepKey: `guided:${item.id}`,
            status: input.result === "present" ? "USER_CONFIRMED_PRESENT" : "UNVERIFIED",
            payload: {
              ...payload,
              reconciledAt: iso(this.now),
              assurance: input.result === "present" ? "USER_ATTESTATION_ONLY" : "NO_VERIFICATION",
              resourceLeaseOwnerId: undefined,
            },
            attempt: Number(journal.attempt ?? 0),
          });
        });
      }
      const refreshed = this.database.getTransfer(transferId)!;
      const remaining = this.items(transferId).some((entry) => ACTIVE_ITEM_STATES.has(entry.state));
      if (!remaining) this.finish(refreshed);
      return this.view(transferId);
    });
  }

  private finish(transfer: TransferRecord): void {
    let current = transfer;
    if (current.state === "READY_TO_WRITE") current = this.updateState(current, "WRITING");
    if (current.state !== "WRITING") return;
    current = this.updateState(current, "VERIFYING");
    const items = this.items(current.id);
    const report = reportFor(this.database, current.id, items);
    const expected = (current.writePlan as { expectedItemWrites?: number } | undefined)?.expectedItemWrites ?? 0;
    const unexpectedSkipped = items.filter((item) => item.state === "SKIPPED_NOT_FOUND").length;
    const complete = report.successful === expected && report.counts.ERROR === 0 && report.counts.UNVERIFIED === 0 && unexpectedSkipped === 0;
    current = this.updateState(current, complete ? "COMPLETED" : "PARTIAL");
    const destination = destinationOf(current);
    this.saveTransfer({
      ...current,
      destination: json({
        ...destination,
        retainedSummary: {
          counts: report.counts,
          successful: report.successful,
          independentlyVerified: report.independentlyVerified,
          userConfirmedOnly: report.userConfirmedOnly,
          notCountedAsSuccess: report.notCountedAsSuccess,
          totalItems: items.length,
          completedAtMs: this.now().getTime(),
          disclaimer: report.disclaimer,
        },
      }),
      completedAtMs: this.now().getTime(),
    });
  }

  async cancel(transferId: string) {
    return this.locked(transferId, async () => {
      const transfer = this.database.getTransfer(transferId);
      if (!transfer) throw new Error("TRANSFER_NOT_FOUND");
      if (["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(transfer.state)) return this.view(transferId);
      const journals = this.database.listJournal(transferId);
      const items = this.items(transferId);
      const receiptKeys = new Set(this.database.listReceipts(transferId).map((receipt) => receipt.idempotencyKey));
      const ambiguousStatuses = new Set(["RUNNING", "AWAITING_USER", "AMBIGUOUS_REQUIRES_USER_BINDING"]);
      const ambiguous = journals.filter((entry) => ambiguousStatuses.has(String(entry.status))
        && ["API_ADD", "GUIDED_ADD", "RECONCILIATION", "CREATE_PLAYLIST"].includes(String(entry.stepKind)));
      let hasPossibleWrites = receiptKeys.size > 0 || ambiguous.length > 0;
      let createdUnverified = 0;
      const cancelledAt = iso(this.now);
      this.database.transaction(() => {
        for (const entry of ambiguous) {
          const payload = (entry.payload ?? {}) as JsonObject;
          const idempotencyKey = typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : undefined;
          const item = idempotencyKey ? items.find((candidate) => candidate.idempotencyKey === idempotencyKey) : undefined;
          if (item && !receiptKeys.has(idempotencyKey!) && item.selectedTarget
            && ["WRITE_PENDING", "AWAITING_USER_RECONCILIATION", "WRITTEN"].includes(item.state)) {
            const destinationPlaylistId = typeof payload.destinationPlaylistId === "string"
              ? payload.destinationPlaylistId
              : findPlanItem(transfer.writePlan as unknown as ImmutableWritePlan, item.id)?.destinationPlaylistId;
            const writtenAt = typeof payload.issuedAt === "string" ? payload.issuedAt : cancelledAt;
            if (destinationPlaylistId) {
              const receipt = createUnverifiedReceipt(
                baseReceipt(item, transferId, destinationPlaylistId, writtenAt),
                "Transfer was cancelled while a provider mutation could already have occurred; exact presence was not reconciled",
              );
              saveReceipt(this.database, item, receipt, item.riskFlags.length > 0);
              persistItem(this.database, {
                ...item,
                state: transitionTrackItem(item.state, "WRITE_UNVERIFIED", { receipt }),
                riskFlags: [...new Set([...item.riskFlags, "CANCELLED_DURING_AMBIGUOUS_PROVIDER_ACTION"])],
              });
              receiptKeys.add(idempotencyKey!);
              createdUnverified += 1;
            }
          }
          this.database.appendJournal({
            transferId,
            sequence: Number(entry.sequence),
            stepKind: String(entry.stepKind),
            stepKey: String(entry.stepKey),
            status: "CANCELLED_WITH_POSSIBLE_PROVIDER_MUTATION",
            payload: {
              ...payload,
              resourceLeaseOwnerId: undefined,
              cancelledAt,
              assurance: "UNVERIFIED_PROVIDER_MUTATION_POSSIBLE",
            },
            attempt: Number(entry.attempt ?? 0),
          });
        }
        hasPossibleWrites = hasPossibleWrites || createdUnverified > 0;
        const next: TransferState = hasPossibleWrites ? "PARTIAL" : "CANCELLED";
        const nextTransfer = hasPossibleWrites
          ? withLimitations(transfer, "CANCELLED_WITH_POSSIBLE_UNVERIFIED_PROVIDER_MUTATION")
          : transfer;
        this.saveTransfer({
          ...nextTransfer,
          state: transitionTransfer(asTransferState(transfer.state), next),
          completedAtMs: this.now().getTime(),
        });
        this.database.audit("TRANSFER_CANCELLED", transferId, {
          partial: hasPossibleWrites,
          ambiguousProviderSteps: ambiguous.length,
          unverifiedReceiptsCreated: createdUnverified,
        });
      });
      return this.view(transferId);
    });
  }

  list() {
    return this.database.listTransfers().map((transfer) => {
      const items = this.items(transfer.id);
      return {
        ...transfer,
        progress: this.progress(items),
        report: reportWithRetained(this.database, transfer.id, items, destinationOf(transfer).retainedSummary),
      };
    });
  }

  private progress(items: StoredItem[]) {
    const done = items.filter((item) => !ACTIVE_ITEM_STATES.has(item.state)).length;
    return { total: items.length, done, percent: items.length ? Math.round((done / items.length) * 100) : 0 };
  }

  view(transferId: string) {
    const transfer = this.database.getTransfer(transferId);
    if (!transfer) throw new Error("TRANSFER_NOT_FOUND");
    const items = this.items(transferId);
    const destination = destinationOf(transfer);
    const blueprint = destination.blueprint;
    const externalGate = transfer.sourceProvider === "soundcloud" || transfer.destinationProvider === "soundcloud"
      ? {
          code: "SC-BASE-LEGAL",
          status: "MANUAL_ONLY" as const,
          reason: "No positive documented permission for SoundCloud automation is available; only explicit user-operated official-page actions are emitted.",
          providerMutationPerformed: false,
        }
      : undefined;
    const bindingNeeds = blueprint
      ? blueprint.destinations
          .filter((entry) => !entry.existingProviderPlaylistId && !destination.bindings[entry.destinationPlanKey])
          .map((entry) => ({
            planKey: entry.destinationPlanKey,
            title: entry.metadata.title,
            description: entry.metadata.description,
            privacy: entry.metadata.privacy ?? "provider-default",
            copyCover: entry.metadata.copyCover,
            provider: transfer.destinationProvider,
            requiresNewEmptyDestination: true,
            expectedVisibleItemCount: 0,
            createUrl: transfer.destinationProvider === "spotify" ? "https://open.spotify.com/collection/playlists" : transfer.destinationProvider === "soundcloud" ? "https://soundcloud.com/you/sets" : "https://www.youtube.com/feed/playlists",
            userOperated: true,
          }))
      : [];
    const awaiting = items.find((item) => item.state === "AWAITING_USER_RECONCILIATION");
    const pendingBase = awaiting ? this.pendingGuidedAction(transferId, awaiting.id) : undefined;
    const pendingJournal = awaiting ? this.database.listJournal(transferId).find((entry) => entry.stepKey === `guided:${awaiting.id}` && entry.status === "AWAITING_USER") : undefined;
    const pendingAction = pendingBase ? {
      ...pendingBase,
      actionId: pendingBase.id,
      transferItemId: awaiting!.id,
      officialUrl: pendingBase.openUrl,
      targetUrl: pendingBase.openUrl,
      videoId: pendingBase.provider === "youtube" ? pendingBase.targetEntityId : undefined,
      destinationPlaylistId: typeof (pendingJournal?.payload as JsonObject | undefined)?.destinationPlaylistId === "string" ? (pendingJournal!.payload as JsonObject).destinationPlaylistId : undefined,
    } : bindingNeeds[0] ? {
      id: `bind:${bindingNeeds[0].planKey}`,
      actionId: `bind:${bindingNeeds[0].planKey}`,
      provider: transfer.destinationProvider,
      kind: "CREATE_PLAYLIST",
      title: `Create a new empty “${bindingNeeds[0].title}”`,
      instructions: ["Open the official provider UI and create a new owned playlist for this transfer.", "Do not select or reuse an existing playlist; confirm the newly created playlist visibly contains zero items.", "Paste its real playlist share URL back into this app and attest the zero visible count."],
      openUrl: bindingNeeds[0].createUrl,
      officialUrl: bindingNeeds[0].createUrl,
      requiresFreshDestinationConfirmation: false,
      expectedDestinationItemCount: undefined as number | undefined,
      destinationBaselineKind: undefined as "NEW_EMPTY_AT_BINDING" | "EXISTING_SNAPSHOT" | undefined,
      confirmedPriorAdds: undefined as number | undefined,
      expectedManualActions: 3,
      automation: "USER_OPERATED",
    } : undefined;
    const receipts = this.database.listReceipts(transferId);
    const publicItems = items.map((item) => ({
      ...item,
      selection: item.selectedTarget,
      selectedTarget: item.selectedTarget?.target,
      receipt: activeReceipt(receipts, item.id),
      searchUrl: item.state === "NEEDS_REVIEW" ? buildSearchUrl(asProvider(transfer.destinationProvider), `${item.sourceRef.artistRaw ?? ""} ${item.sourceRef.titleRaw}`.trim()) : undefined,
    }));
    const view = {
      transfer: { ...transfer, destination: { ...destination, blueprint: undefined } },
      items: publicItems,
      receipts,
      report: { ...reportWithRetained(this.database, transferId, items, destination.retainedSummary), limitations: transfer.limitationCodes, rawDetailExpiredAtMs: destination.rawDetailExpiredAtMs },
      progress: this.progress(items),
      pendingAction,
      bindingNeeds,
      externalGate,
      journal: this.database.listJournal(transferId).map((entry) => ({ sequence: entry.sequence, stepKind: entry.stepKind, status: entry.status, updatedAtMs: entry.updatedAtMs })),
      capabilities: {
        strategy: transfer.destinationProvider === "youtube" && (() => { try { this.youtubeClient(); return true; } catch { return false; } })() ? "api-with-guided-fallback" : "guided",
        domRead: false,
        uiAutomation: false,
        fullSideBySideComparison: false,
        soundcloudTransfer: externalGate ? "guided-manual-only" : "not-applicable",
      },
      limitations: transfer.limitationCodes,
    };
    return redactSecrets(view) as typeof view;
  }
}

declare global {
  var __playlistTransferCoordinator: TransferCoordinator | undefined;
}

export function getTransferCoordinator(): TransferCoordinator {
  if (!globalThis.__playlistTransferCoordinator) globalThis.__playlistTransferCoordinator = new TransferCoordinator();
  return globalThis.__playlistTransferCoordinator;
}
