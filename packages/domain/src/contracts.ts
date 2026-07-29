import type { PlaylistEligibilityStatus } from "./eligibility.js";
import type { CandidateValidation, WriteReceipt } from "./evidence.js";
import type {
  AdapterStrategy,
  Provider,
  ProviderCapabilities,
  ProviderTrackReference,
} from "./provider.js";
import type { TransferSettings } from "./settings.js";
import type { TrackItemState, TransferState } from "./state-machine.js";

export interface User {
  readonly id: string;
  readonly displayName: string;
  readonly locale: "ru" | "en";
  readonly localCredentialKind: "PASSKEY" | "OS_PASSWORD";
  readonly createdAt: string;
}

export interface ServiceConnection {
  readonly id: string;
  readonly provider: Provider;
  readonly accountId: string;
  readonly accountLabel: string;
  readonly strategy: AdapterStrategy;
  readonly scopes: readonly string[];
  readonly capabilities: ProviderCapabilities;
  readonly status: "CONNECTED" | "DISCONNECTED" | "REAUTH_REQUIRED" | "LIMITED_PERMISSIONS";
  readonly encryptedTokenReference?: string;
}

export interface PlaylistSnapshot {
  readonly id: string;
  readonly provider: Provider;
  readonly providerPlaylistId: string;
  readonly title: string;
  readonly description?: string;
  readonly privacy?: string;
  readonly ownerId?: string;
  readonly eligibility: PlaylistEligibilityStatus;
  readonly sourceVersion: string;
  readonly sourceHash: string;
  readonly importedAt: string;
  readonly itemCount: number;
}

export interface TrackSnapshot {
  readonly id: string;
  readonly playlistSnapshotId: string;
  readonly position: number;
  readonly source: ProviderTrackReference;
  readonly rawMetadata: Readonly<Record<string, unknown>>;
  readonly transferable: boolean;
  readonly exclusionReason?: string;
}

export interface TrackHypothesisRecord {
  readonly id: string;
  readonly trackSnapshotId: string;
  readonly kind: string;
  readonly title: string;
  readonly artist?: string;
  readonly contributors: readonly string[];
  readonly versionMarkers: readonly string[];
}

export type TransferMode = "SEPARATE_COPY" | "MERGE_NEW" | "APPEND_EXISTING";

export interface Transfer {
  readonly id: string;
  readonly sourceProvider: Provider;
  readonly destinationProvider: Provider;
  readonly sourcePlaylistSnapshotIds: readonly string[];
  readonly mode: TransferMode;
  readonly settings: TransferSettings;
  readonly state: TransferState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransferPlaylist {
  readonly transferId: string;
  readonly sourcePlaylistSnapshotIds: readonly string[];
  readonly destinationPlaylistId?: string;
  readonly destinationPlanKey: string;
}

export interface SearchAttempt {
  readonly id: string;
  readonly transferId: string;
  readonly trackSnapshotId: string;
  readonly queryVariant: string;
  readonly provider: Provider;
  readonly attemptedAt: string;
  readonly quotaCost: number;
}

export interface CandidateRecord {
  readonly id: string;
  readonly transferId: string;
  readonly trackSnapshotId: string;
  readonly target: ProviderTrackReference;
  readonly validation: CandidateValidation;
  readonly score: number;
  readonly rank: number;
  readonly scoreEvidence: readonly { readonly signal: string; readonly points: number; readonly detail: string }[];
}

export interface ReviewDecision {
  readonly id: string;
  readonly transferId: string;
  readonly trackSnapshotId: string;
  readonly decision: "SELECTED" | "SKIPPED" | "NO_MATCH";
  readonly selectedCandidateId?: string;
  readonly actor: "USER";
  readonly decidedAt: string;
}

export interface TransferTrackItem {
  readonly transferId: string;
  readonly trackSnapshotId: string;
  readonly state: TrackItemState;
  readonly selectedCandidateId?: string;
  readonly writeReceipt?: WriteReceipt;
}

export interface AuditEvent {
  readonly id: string;
  readonly transferId?: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ExtensionPairSession {
  readonly id: string;
  readonly schemaVersion: number;
  readonly expectedOrigin: string;
  readonly expiresAt: string;
  readonly claimedAt?: string;
}

export interface LocalJobJournalEntry {
  readonly id: string;
  readonly transferId: string;
  readonly sequence: number;
  readonly step: string;
  readonly state: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "PAUSED";
  readonly retryCount: number;
  readonly resumeCursor?: string;
  readonly persistedAt: string;
}
