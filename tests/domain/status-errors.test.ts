import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTrackItemOutcome,
  createProviderVerifiedReceipt,
  createUnverifiedReceipt,
  createUserConfirmedManualReceipt,
  mapProviderError,
  summarizeTrackItemOutcomes,
  type WriteReceiptBase,
} from "../../packages/domain/src/index.js";
import { providerValidation, youtubeTarget } from "./fixtures.js";

function receipts() {
  const base: WriteReceiptBase = {
    receiptId: "r", transferId: "t", destinationPlaylistId: "PL1234567890", target: youtubeTarget(),
    idempotencyKey: "key", writtenAt: "2026-07-29T10:00:00Z",
  };
  return {
    provider: createProviderVerifiedReceipt(base, providerValidation(base.target), {
      kind: "API_READ_AFTER_WRITE", provider: "youtube", destinationPlaylistId: base.destinationPlaylistId,
      checkedAt: "2026-07-29T10:01:00Z", observedProviderEntityIds: [base.target.providerEntityId], evidenceVersion: "v1",
    }),
    manual: createUserConfirmedManualReceipt(base, {
      kind: "USER_DESTINATION_CONFIRMATION", provider: "youtube", destinationPlaylistId: base.destinationPlaylistId,
      providerEntityId: base.target.providerEntityId, confirmedAt: "2026-07-29T10:01:00Z", userAttestedPresent: true,
    }),
    unverified: createUnverifiedReceipt(base, "no read-back"),
  };
}

test("report categories never merge provider verification with user attestation", () => {
  const receipt = receipts();
  assert.deepEqual(classifyTrackItemOutcome("VERIFIED_PROVIDER", receipt.provider), {
    category: "VERIFIED_PROVIDER", successful: true, assurance: "INDEPENDENT_PROVIDER_READ_BACK",
  });
  assert.deepEqual(classifyTrackItemOutcome("USER_CONFIRMED_MANUAL", receipt.manual), {
    category: "USER_CONFIRMED_MANUAL", successful: true, assurance: "USER_ATTESTATION_ONLY",
  });
  assert.equal(classifyTrackItemOutcome("WRITE_CONFIRMED_NON_OWNED").category, "UNVERIFIED");
  assert.equal(classifyTrackItemOutcome("WRITE_UNVERIFIED", receipt.unverified).successful, false);
  assert.throws(() => classifyTrackItemOutcome("VERIFIED_PROVIDER", receipt.manual), /provider-verified receipt/);

  assert.deepEqual(
    summarizeTrackItemOutcomes([
      { state: "VERIFIED_PROVIDER", receipt: receipt.provider },
      { state: "USER_CONFIRMED_MANUAL", receipt: receipt.manual },
      { state: "WRITE_UNVERIFIED", receipt: receipt.unverified },
      { state: "WRITE_FAILED" },
      { state: "SKIPPED_NOT_FOUND" },
    ]),
    { VERIFIED_PROVIDER: 1, USER_CONFIRMED_MANUAL: 1, UNVERIFIED: 1, ERROR: 1, SKIPPED: 1, IN_PROGRESS: 0 },
  );
});

test("provider errors encode no-blind-retry semantics", () => {
  assert.deepEqual(
    mapProviderError({ provider: "youtube", operation: "WRITE", responseReceived: false }),
    {
      provider: "youtube", category: "AMBIGUOUS_NETWORK_RESULT", retry: "VERIFY_BEFORE_RETRY",
      requiresReadVerification: true,
    },
  );
  assert.equal(mapProviderError({ provider: "youtube", operation: "SEARCH", responseReceived: true, httpStatus: 403, providerCode: "quotaExceeded" }).retry, "WAIT_QUOTA_RESET");
  assert.deepEqual(
    mapProviderError({ provider: "spotify", operation: "WRITE", responseReceived: true, httpStatus: 429, retryAfterSeconds: 17 }),
    {
      provider: "spotify", category: "RATE_LIMITED", retry: "WAIT_RETRY_AFTER", retryAfterSeconds: 17,
      requiresReadVerification: false,
    },
  );
  assert.equal(mapProviderError({ provider: "soundcloud", operation: "WRITE", responseReceived: true, httpStatus: 403 }).retry, "NEVER");
  assert.equal(mapProviderError({ provider: "spotify", operation: "READ", responseReceived: true, providerCode: "invalid_grant" }).retry, "REAUTHENTICATE");
});
