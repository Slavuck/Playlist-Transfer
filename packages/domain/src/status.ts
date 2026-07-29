import { assertHonestWriteReceipt, type WriteReceipt } from "./evidence.js";
import type { TrackItemState } from "./state-machine.js";

export type HonestReportCategory =
  | "VERIFIED_PROVIDER"
  | "USER_CONFIRMED_MANUAL"
  | "UNVERIFIED"
  | "ERROR"
  | "SKIPPED"
  | "IN_PROGRESS";

export interface HonestItemOutcome {
  readonly category: HonestReportCategory;
  readonly successful: boolean;
  readonly assurance:
    | "INDEPENDENT_PROVIDER_READ_BACK"
    | "USER_ATTESTATION_ONLY"
    | "NO_VERIFICATION"
    | "NOT_APPLICABLE";
}

export function classifyTrackItemOutcome(
  state: TrackItemState,
  receipt?: WriteReceipt,
): HonestItemOutcome {
  if (state === "VERIFIED_PROVIDER") {
    if (!receipt || receipt.verificationStatus !== "VERIFIED_PROVIDER") {
      throw new Error("VERIFIED_PROVIDER report state requires its provider-verified receipt");
    }
    assertHonestWriteReceipt(receipt);
    return { category: "VERIFIED_PROVIDER", successful: true, assurance: "INDEPENDENT_PROVIDER_READ_BACK" };
  }
  if (state === "USER_CONFIRMED_MANUAL") {
    if (!receipt || receipt.verificationStatus !== "USER_CONFIRMED_MANUAL") {
      throw new Error("USER_CONFIRMED_MANUAL report state requires its manual receipt");
    }
    assertHonestWriteReceipt(receipt);
    return { category: "USER_CONFIRMED_MANUAL", successful: true, assurance: "USER_ATTESTATION_ONLY" };
  }
  if (state === "WRITE_FAILED") {
    return { category: "ERROR", successful: false, assurance: "NO_VERIFICATION" };
  }
  if (state === "SKIPPED_NOT_FOUND" || state === "SKIPPED_DUPLICATE") {
    return { category: "SKIPPED", successful: false, assurance: "NOT_APPLICABLE" };
  }
  if (state === "WRITE_UNVERIFIED" || state === "WRITE_CONFIRMED_NON_OWNED" || state === "WRITTEN") {
    return { category: "UNVERIFIED", successful: false, assurance: "NO_VERIFICATION" };
  }
  return { category: "IN_PROGRESS", successful: false, assurance: "NOT_APPLICABLE" };
}

export type HonestOutcomeCounts = Readonly<Record<HonestReportCategory, number>>;

export function summarizeTrackItemOutcomes(
  items: readonly { readonly state: TrackItemState; readonly receipt?: WriteReceipt }[],
): HonestOutcomeCounts {
  const counts: Record<HonestReportCategory, number> = {
    VERIFIED_PROVIDER: 0,
    USER_CONFIRMED_MANUAL: 0,
    UNVERIFIED: 0,
    ERROR: 0,
    SKIPPED: 0,
    IN_PROGRESS: 0,
  };
  for (const item of items) counts[classifyTrackItemOutcome(item.state, item.receipt).category] += 1;
  return counts;
}
