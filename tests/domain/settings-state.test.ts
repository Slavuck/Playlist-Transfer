import assert from "node:assert/strict";
import test from "node:test";
import {
  cancellationOutcome,
  createProviderVerifiedReceipt,
  createTransferSettings,
  createUnverifiedReceipt,
  createUserConfirmedManualReceipt,
  isTerminalTransferState,
  resolveMatchingBehavior,
  transitionTrackItem,
  transitionTransfer,
  type WriteReceiptBase,
} from "../../packages/domain/src/index.js";
import { providerValidation, youtubeTarget } from "./fixtures.js";

test("matching risk and review are persisted per transfer and combine independently", () => {
  const defaults = createTransferSettings();
  assert.deepEqual(defaults.matching, {
    riskMode: "SAFE",
    reviewUncertain: true,
    riskyRelevanceFallbackMinTitleSimilarity: 0.72,
    maxReviewCandidates: 5,
  });
  assert.equal(resolveMatchingBehavior(defaults.matching), "SAFE_WITH_REVIEW");
  assert.equal(resolveMatchingBehavior({ ...defaults.matching, reviewUncertain: false }), "SAFE_SKIP_UNCERTAIN");
  assert.equal(resolveMatchingBehavior({ ...defaults.matching, riskMode: "RISKY" }), "RISKY_WITH_REVIEW");
  assert.equal(
    resolveMatchingBehavior({ ...defaults.matching, riskMode: "RISKY", reviewUncertain: false }),
    "RISKY_AUTO_WITH_RELEVANCE_FALLBACK",
  );
});

test("sensitive per-transfer options require explicit confirmation", () => {
  assert.throws(() => createTransferSettings({ copyCover: true }), /rights confirmation/);
  assert.doesNotThrow(() => createTransferSettings({ copyCover: true, coverRightsConfirmed: true }));
  assert.throws(() => createTransferSettings({ destinationPrivacy: "PUBLIC" }), /privacy.*confirmation/i);
  assert.throws(
    () => createTransferSettings({ matching: { riskyRelevanceFallbackMinTitleSimilarity: 1.1 } }),
    /between 0 and 1/,
  );
  assert.throws(() => createTransferSettings({ matching: { maxReviewCandidates: 2 } }), /between 3 and 5/);
});

test("transfer state machine follows durable orchestration and replays same state idempotently", () => {
  let state = transitionTransfer("DRAFT", "PREFLIGHT");
  state = transitionTransfer(state, "SNAPSHOTTING");
  state = transitionTransfer(state, "MATCHING");
  state = transitionTransfer(state, "NEEDS_REVIEW");
  state = transitionTransfer(state, "READY_TO_WRITE");
  state = transitionTransfer(state, "WRITING");
  state = transitionTransfer(state, "VERIFYING");
  state = transitionTransfer(state, "COMPLETED");
  assert.equal(state, "COMPLETED");
  assert.equal(transitionTransfer(state, state), "COMPLETED");
  assert.equal(isTerminalTransferState(state), true);
  assert.throws(() => transitionTransfer("DRAFT", "WRITING"), /Invalid transfer state transition/);
  assert.deepEqual([cancellationOutcome(false), cancellationOutcome(true)], ["CANCELLED", "PARTIAL"]);
});

function baseReceipt(): WriteReceiptBase {
  return {
    receiptId: "r-1", transferId: "t-1", destinationPlaylistId: "PL1234567890",
    target: youtubeTarget(), idempotencyKey: "k-1", writtenAt: "2026-07-29T10:02:00Z",
  };
}

test("track state machine rejects honest-status promotions without matching evidence", () => {
  assert.equal(transitionTrackItem("PENDING", "MATCHED_AUTO"), "MATCHED_AUTO");
  assert.equal(transitionTrackItem("MATCHED_AUTO", "WRITE_PENDING"), "WRITE_PENDING");
  assert.equal(transitionTrackItem("WRITE_PENDING", "WRITTEN"), "WRITTEN");
  assert.throws(() => transitionTrackItem("WRITTEN", "VERIFIED_PROVIDER"), /requires a persisted write receipt/);

  const base = baseReceipt();
  const providerReceipt = createProviderVerifiedReceipt(base, providerValidation(base.target), {
    kind: "API_READ_AFTER_WRITE", provider: "youtube", destinationPlaylistId: base.destinationPlaylistId,
    checkedAt: "2026-07-29T10:03:00Z", observedProviderEntityIds: [base.target.providerEntityId], evidenceVersion: "v1",
  });
  assert.equal(
    transitionTrackItem("WRITTEN", "VERIFIED_PROVIDER", { receipt: providerReceipt }),
    "VERIFIED_PROVIDER",
  );

  const manualReceipt = createUserConfirmedManualReceipt(base, {
    kind: "USER_DESTINATION_CONFIRMATION", provider: "youtube", destinationPlaylistId: base.destinationPlaylistId,
    providerEntityId: base.target.providerEntityId, confirmedAt: "2026-07-29T10:03:00Z", userAttestedPresent: true,
  });
  assert.throws(
    () => transitionTrackItem("WRITTEN", "VERIFIED_PROVIDER", { receipt: manualReceipt }),
    /requires a VERIFIED_PROVIDER receipt/,
  );
  assert.equal(
    transitionTrackItem("AWAITING_USER_RECONCILIATION", "USER_CONFIRMED_MANUAL", { receipt: manualReceipt }),
    "USER_CONFIRMED_MANUAL",
  );

  const unverified = createUnverifiedReceipt(base, "read-back unavailable");
  assert.equal(transitionTrackItem("WRITTEN", "WRITE_UNVERIFIED", { receipt: unverified }), "WRITE_UNVERIFIED");
});

test("guided ambiguity cannot retry until reconciliation moves it back to pending", () => {
  assert.equal(transitionTrackItem("WRITE_PENDING", "AWAITING_USER_RECONCILIATION"), "AWAITING_USER_RECONCILIATION");
  assert.throws(() => transitionTrackItem("AWAITING_USER_RECONCILIATION", "WRITTEN"), /Invalid track item/);
  assert.equal(transitionTrackItem("AWAITING_USER_RECONCILIATION", "WRITE_PENDING"), "WRITE_PENDING");
});
