import {
  assertProviderTrackReference,
  type Provider,
  type ProviderTrackReference,
} from "./provider.js";

export type CandidateValidationStatus =
  | "UNVALIDATED"
  | "PROVIDER_VALIDATED"
  | "USER_SELECTED_REAL_URL"
  | "USER_SELECTED_UNVERIFIED"
  | "INVALID";

export interface ProviderEntityValidationEvidence {
  readonly kind: "PROVIDER_API" | "PROVIDER_OEMBED" | "APPROVED_PROVIDER_PAGE";
  readonly provider: Provider;
  readonly providerEntityId: string;
  readonly checkedAt: string;
  readonly exists: true;
  readonly accessibleToCurrentUser?: boolean;
  readonly evidenceVersion: string;
}

export interface UserSelectedUrlEvidence {
  readonly kind: "USER_SHARE_URL_OPENED";
  readonly provider: Provider;
  readonly providerEntityId: string;
  readonly confirmedAt: string;
  readonly openedOfficialOrigin: true;
}

export type CandidateValidation =
  | { readonly status: "UNVALIDATED" | "USER_SELECTED_UNVERIFIED" | "INVALID"; readonly evidence?: undefined }
  | { readonly status: "PROVIDER_VALIDATED"; readonly evidence: ProviderEntityValidationEvidence }
  | { readonly status: "USER_SELECTED_REAL_URL"; readonly evidence: UserSelectedUrlEvidence };

export interface ProviderReadAfterWriteEvidence {
  readonly kind: "API_READ_AFTER_WRITE" | "APPROVED_READER_READ_AFTER_WRITE";
  readonly provider: Provider;
  readonly destinationPlaylistId: string;
  readonly checkedAt: string;
  readonly observedProviderEntityIds: readonly string[];
  readonly evidenceVersion: string;
}

export interface ManualWriteConfirmation {
  readonly kind: "USER_DESTINATION_CONFIRMATION";
  readonly provider: Provider;
  readonly destinationPlaylistId: string;
  readonly providerEntityId: string;
  readonly confirmedAt: string;
  readonly userAttestedPresent: true;
}

export interface WriteReceiptBase {
  readonly receiptId: string;
  readonly transferId: string;
  readonly destinationPlaylistId: string;
  readonly target: ProviderTrackReference;
  readonly idempotencyKey: string;
  readonly writtenAt: string;
  readonly providerResponseId?: string;
  readonly providerVersion?: string;
}

export interface ProviderVerifiedWriteReceipt extends WriteReceiptBase {
  readonly verificationStatus: "VERIFIED_PROVIDER";
  readonly targetValidation: CandidateValidation & { readonly status: "PROVIDER_VALIDATED" };
  readonly readAfterWrite: ProviderReadAfterWriteEvidence;
}

export interface UserConfirmedManualWriteReceipt extends WriteReceiptBase {
  readonly verificationStatus: "USER_CONFIRMED_MANUAL";
  readonly userConfirmation: ManualWriteConfirmation;
}

export interface UnverifiedWriteReceipt extends WriteReceiptBase {
  readonly verificationStatus: "WRITE_UNVERIFIED";
  readonly reason: string;
}

export interface NonOwnedWriteReceipt extends WriteReceiptBase {
  readonly verificationStatus: "WRITE_CONFIRMED_NON_OWNED";
  readonly reason: "WRITE_SUCCEEDED_BUT_COLLABORATOR_MEMBERSHIP_UNPROVEN";
}

export type WriteReceipt =
  | ProviderVerifiedWriteReceipt
  | UserConfirmedManualWriteReceipt
  | UnverifiedWriteReceipt
  | NonOwnedWriteReceipt;

function assertTimestamp(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${label} must be an ISO-compatible timestamp`);
}

function assertReceiptBase(base: WriteReceiptBase): void {
  assertProviderTrackReference(base.target);
  if (!base.receiptId.trim() || !base.transferId.trim() || !base.destinationPlaylistId.trim()) {
    throw new TypeError("Receipt, transfer and destination playlist IDs are required");
  }
  if (!base.idempotencyKey.trim()) throw new TypeError("idempotencyKey is required");
  assertTimestamp(base.writtenAt, "writtenAt");
}

export function createProviderValidation(
  target: ProviderTrackReference,
  evidence: ProviderEntityValidationEvidence,
): CandidateValidation & { readonly status: "PROVIDER_VALIDATED" } {
  assertProviderTrackReference(target);
  if (!evidence.exists || evidence.provider !== target.provider || evidence.providerEntityId !== target.providerEntityId) {
    throw new Error("Provider validation evidence must independently confirm the exact target ID");
  }
  assertTimestamp(evidence.checkedAt, "validation checkedAt");
  if (!evidence.evidenceVersion.trim()) throw new TypeError("Validation evidenceVersion is required");
  return { status: "PROVIDER_VALIDATED", evidence };
}

export function createUserSelectedRealUrlValidation(
  target: ProviderTrackReference,
  evidence: UserSelectedUrlEvidence,
): CandidateValidation & { readonly status: "USER_SELECTED_REAL_URL" } {
  assertProviderTrackReference(target);
  if (
    evidence.provider !== target.provider ||
    evidence.providerEntityId !== target.providerEntityId ||
    !evidence.openedOfficialOrigin
  ) {
    throw new Error("User URL evidence must refer to the exact target on an official origin");
  }
  assertTimestamp(evidence.confirmedAt, "URL confirmation timestamp");
  return { status: "USER_SELECTED_REAL_URL", evidence };
}

export function assertCandidateValidation(
  target: ProviderTrackReference,
  validation: CandidateValidation,
): void {
  if (validation.status === "PROVIDER_VALIDATED") {
    createProviderValidation(target, validation.evidence);
    return;
  }
  if (validation.status === "USER_SELECTED_REAL_URL") {
    createUserSelectedRealUrlValidation(target, validation.evidence);
    return;
  }
  if (!["UNVALIDATED", "USER_SELECTED_UNVERIFIED", "INVALID"].includes(validation.status)) {
    throw new TypeError("Unknown candidate validation status");
  }
  if (validation.evidence !== undefined) {
    throw new Error("Unverified candidate statuses cannot carry validation evidence");
  }
}

export function createProviderVerifiedReceipt(
  base: WriteReceiptBase,
  targetValidation: CandidateValidation,
  readAfterWrite: ProviderReadAfterWriteEvidence,
): ProviderVerifiedWriteReceipt {
  assertReceiptBase(base);
  if (targetValidation.status !== "PROVIDER_VALIDATED") {
    throw new Error("VERIFIED_PROVIDER requires independent target validation");
  }
  if (
    targetValidation.evidence.provider !== base.target.provider ||
    targetValidation.evidence.providerEntityId !== base.target.providerEntityId
  ) {
    throw new Error("Target validation does not match the write target");
  }
  if (
    readAfterWrite.provider !== base.target.provider ||
    readAfterWrite.destinationPlaylistId !== base.destinationPlaylistId ||
    !readAfterWrite.observedProviderEntityIds.includes(base.target.providerEntityId)
  ) {
    throw new Error("VERIFIED_PROVIDER requires read-after-write presence of the exact target ID");
  }
  assertTimestamp(readAfterWrite.checkedAt, "read-after-write checkedAt");
  if (Date.parse(readAfterWrite.checkedAt) < Date.parse(base.writtenAt)) {
    throw new Error("Read-after-write evidence cannot predate the write");
  }
  if (!readAfterWrite.evidenceVersion.trim()) throw new TypeError("Read-back evidenceVersion is required");
  return { ...base, verificationStatus: "VERIFIED_PROVIDER", targetValidation, readAfterWrite };
}

export function createUserConfirmedManualReceipt(
  base: WriteReceiptBase,
  confirmation: ManualWriteConfirmation,
): UserConfirmedManualWriteReceipt {
  assertReceiptBase(base);
  if (
    confirmation.provider !== base.target.provider ||
    confirmation.destinationPlaylistId !== base.destinationPlaylistId ||
    confirmation.providerEntityId !== base.target.providerEntityId ||
    !confirmation.userAttestedPresent
  ) {
    throw new Error("Manual confirmation must attest the exact target and destination");
  }
  assertTimestamp(confirmation.confirmedAt, "manual confirmation timestamp");
  if (Date.parse(confirmation.confirmedAt) < Date.parse(base.writtenAt)) {
    throw new Error("Manual destination confirmation cannot predate the write action");
  }
  return { ...base, verificationStatus: "USER_CONFIRMED_MANUAL", userConfirmation: confirmation };
}

export function createUnverifiedReceipt(base: WriteReceiptBase, reason: string): UnverifiedWriteReceipt {
  assertReceiptBase(base);
  if (!reason.trim()) throw new TypeError("An unverified receipt must explain why verification is absent");
  return { ...base, verificationStatus: "WRITE_UNVERIFIED", reason };
}

export function assertHonestWriteReceipt(receipt: WriteReceipt): void {
  if (receipt.verificationStatus === "VERIFIED_PROVIDER") {
    createProviderVerifiedReceipt(receipt, receipt.targetValidation, receipt.readAfterWrite);
  } else if (receipt.verificationStatus === "USER_CONFIRMED_MANUAL") {
    createUserConfirmedManualReceipt(receipt, receipt.userConfirmation);
  } else {
    assertReceiptBase(receipt);
  }
}

export function isIndependentlyProviderVerified(
  receipt: WriteReceipt,
): receipt is ProviderVerifiedWriteReceipt {
  try {
    if (receipt.verificationStatus !== "VERIFIED_PROVIDER") return false;
    assertHonestWriteReceipt(receipt);
    return true;
  } catch {
    return false;
  }
}

export function isReportedSuccess(receipt: WriteReceipt): boolean {
  return receipt.verificationStatus === "VERIFIED_PROVIDER" || receipt.verificationStatus === "USER_CONFIRMED_MANUAL";
}
