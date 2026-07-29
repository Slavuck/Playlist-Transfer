import { assertHonestWriteReceipt, type WriteReceipt } from "./evidence.js";

export const TRANSFER_STATES = [
  "DRAFT",
  "PREFLIGHT",
  "SNAPSHOTTING",
  "MATCHING",
  "NEEDS_REVIEW",
  "READY_TO_WRITE",
  "WRITING",
  "VERIFYING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
] as const;

export type TransferState = (typeof TRANSFER_STATES)[number];

export const TRACK_ITEM_STATES = [
  "PENDING",
  "MATCHED_AUTO",
  "NEEDS_REVIEW",
  "USER_SELECTED",
  "SKIPPED_NOT_FOUND",
  "SKIPPED_DUPLICATE",
  "WRITE_PENDING",
  "AWAITING_USER_RECONCILIATION",
  "WRITTEN",
  "VERIFIED_PROVIDER",
  "USER_CONFIRMED_MANUAL",
  "WRITE_CONFIRMED_NON_OWNED",
  "WRITE_UNVERIFIED",
  "WRITE_FAILED",
] as const;

export type TrackItemState = (typeof TRACK_ITEM_STATES)[number];

const TRANSFER_TRANSITIONS: Readonly<Record<TransferState, readonly TransferState[]>> = {
  DRAFT: ["PREFLIGHT", "PARTIAL", "CANCELLED"],
  PREFLIGHT: ["SNAPSHOTTING", "PARTIAL", "FAILED", "CANCELLED"],
  SNAPSHOTTING: ["MATCHING", "PARTIAL", "FAILED", "CANCELLED"],
  MATCHING: ["NEEDS_REVIEW", "READY_TO_WRITE", "PARTIAL", "FAILED", "CANCELLED"],
  NEEDS_REVIEW: ["READY_TO_WRITE", "PARTIAL", "FAILED", "CANCELLED"],
  READY_TO_WRITE: ["WRITING", "PARTIAL", "FAILED", "CANCELLED"],
  WRITING: ["VERIFYING", "PARTIAL", "FAILED", "CANCELLED"],
  VERIFYING: ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"],
  COMPLETED: [],
  PARTIAL: [],
  FAILED: [],
  CANCELLED: [],
};

const TRACK_TRANSITIONS: Readonly<Record<TrackItemState, readonly TrackItemState[]>> = {
  PENDING: ["MATCHED_AUTO", "NEEDS_REVIEW", "SKIPPED_NOT_FOUND"],
  MATCHED_AUTO: ["WRITE_PENDING", "NEEDS_REVIEW", "SKIPPED_DUPLICATE"],
  NEEDS_REVIEW: ["USER_SELECTED", "SKIPPED_NOT_FOUND"],
  USER_SELECTED: ["WRITE_PENDING", "NEEDS_REVIEW", "SKIPPED_DUPLICATE"],
  SKIPPED_NOT_FOUND: ["NEEDS_REVIEW"],
  SKIPPED_DUPLICATE: [],
  WRITE_PENDING: ["WRITTEN", "AWAITING_USER_RECONCILIATION", "WRITE_FAILED", "WRITE_UNVERIFIED"],
  AWAITING_USER_RECONCILIATION: [
    "WRITE_PENDING",
    "USER_CONFIRMED_MANUAL",
    "WRITE_UNVERIFIED",
    "WRITE_FAILED",
  ],
  WRITTEN: [
    "VERIFIED_PROVIDER",
    "USER_CONFIRMED_MANUAL",
    "WRITE_CONFIRMED_NON_OWNED",
    "WRITE_UNVERIFIED",
    "WRITE_FAILED",
  ],
  VERIFIED_PROVIDER: [],
  USER_CONFIRMED_MANUAL: ["VERIFIED_PROVIDER"],
  WRITE_CONFIRMED_NON_OWNED: ["VERIFIED_PROVIDER", "USER_CONFIRMED_MANUAL", "WRITE_UNVERIFIED"],
  WRITE_UNVERIFIED: ["VERIFIED_PROVIDER", "USER_CONFIRMED_MANUAL", "WRITE_FAILED"],
  WRITE_FAILED: ["WRITE_PENDING"],
};

export class InvalidStateTransitionError extends Error {
  readonly from: string;
  readonly to: string;

  constructor(scope: "transfer" | "track item", from: string, to: string) {
    super(`Invalid ${scope} state transition: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransitionTransfer(from: TransferState, to: TransferState): boolean {
  // Replaying a durable journal event is intentionally idempotent.
  return from === to || TRANSFER_TRANSITIONS[from].includes(to);
}

export function transitionTransfer(from: TransferState, to: TransferState): TransferState {
  if (!canTransitionTransfer(from, to)) throw new InvalidStateTransitionError("transfer", from, to);
  return to;
}

export function canTransitionTrackItem(from: TrackItemState, to: TrackItemState): boolean {
  return from === to || TRACK_TRANSITIONS[from].includes(to);
}

export interface TrackTransitionEvidence {
  readonly receipt?: WriteReceipt;
}

function assertEvidenceForTerminalStatus(to: TrackItemState, evidence?: TrackTransitionEvidence): void {
  if (to !== "VERIFIED_PROVIDER" && to !== "USER_CONFIRMED_MANUAL" && to !== "WRITE_UNVERIFIED") return;
  if (!evidence?.receipt) throw new Error(`${to} requires a persisted write receipt`);
  assertHonestWriteReceipt(evidence.receipt);
  if (evidence.receipt.verificationStatus !== to) {
    throw new Error(`${to} requires a ${to} receipt, got ${evidence.receipt.verificationStatus}`);
  }
}

export function transitionTrackItem(
  from: TrackItemState,
  to: TrackItemState,
  evidence?: TrackTransitionEvidence,
): TrackItemState {
  if (!canTransitionTrackItem(from, to)) throw new InvalidStateTransitionError("track item", from, to);
  if (from !== to) assertEvidenceForTerminalStatus(to, evidence);
  return to;
}

export function isTerminalTransferState(state: TransferState): boolean {
  return TRANSFER_TRANSITIONS[state].length === 0;
}

export function isTerminalTrackItemState(state: TrackItemState): boolean {
  return TRACK_TRANSITIONS[state].length === 0;
}

export function cancellationOutcome(hasCompletedWrites: boolean): "CANCELLED" | "PARTIAL" {
  return hasCompletedWrites ? "PARTIAL" : "CANCELLED";
}
