import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderValidation,
  assertCandidateValidation,
  createProviderVerifiedReceipt,
  createUnverifiedReceipt,
  createUserConfirmedManualReceipt,
  evaluatePlaylistEligibility,
  isIndependentlyProviderVerified,
  isReportedSuccess,
  type WriteReceiptBase,
} from "../../packages/domain/src/index.js";
import { providerValidation, youtubeTarget } from "./fixtures.js";

test("Spotify eligibility distinguishes owned, verified collaborative and followed public lists", () => {
  const owned = evaluatePlaylistEligibility({
    provider: "spotify", use: "DESTINATION", ownerAccountId: "me", currentAccountId: "me",
    collaborative: false, returnedForCurrentUser: true, contentReadable: true, modifyCapabilityVerified: true,
  });
  assert.deepEqual([owned.eligible, owned.status, owned.independentlyVerified], [true, "PROVIDER_VERIFIED_OWNED", true]);

  const collaborative = evaluatePlaylistEligibility({
    provider: "spotify", use: "DESTINATION", ownerAccountId: "someone", currentAccountId: "me",
    collaborative: true, returnedForCurrentUser: true, contentReadable: true, modifyCapabilityVerified: true,
  });
  assert.equal(collaborative.status, "PROVIDER_VERIFIED_COLLABORATIVE");

  const noWrite = evaluatePlaylistEligibility({
    provider: "spotify", use: "DESTINATION", ownerAccountId: "someone", currentAccountId: "me",
    collaborative: true, returnedForCurrentUser: true, contentReadable: true, modifyCapabilityVerified: false,
  });
  assert.deepEqual([noWrite.eligible, noWrite.reason], [false, "WRITE_CAPABILITY_NOT_VERIFIED"]);

  const followed = evaluatePlaylistEligibility({
    provider: "spotify", use: "SOURCE", currentAccountId: "me", collaborative: false,
    returnedForCurrentUser: true, contentReadable: true, modifyCapabilityVerified: false, followedOrPublicOnly: true,
  });
  assert.equal(followed.eligible, false);
});

test("YouTube non-owned playlist remains experimental and never proves collaboration", () => {
  const denied = evaluatePlaylistEligibility({
    provider: "youtube", use: "DESTINATION", listedByMine: false, manuallySuppliedNonOwned: true,
  });
  assert.deepEqual([denied.eligible, denied.status], [false, "INELIGIBLE"]);

  const experimental = evaluatePlaylistEligibility({
    provider: "youtube", use: "DESTINATION", listedByMine: false, manuallySuppliedNonOwned: true,
    allowExperimentalNonOwned: true,
  });
  assert.deepEqual(
    [experimental.eligible, experimental.status, experimental.independentlyVerified, experimental.experimental],
    [true, "UNVERIFIED_NON_OWNED", false, true],
  );

  const writeSucceeded = evaluatePlaylistEligibility({
    provider: "youtube", use: "DESTINATION", listedByMine: false, manuallySuppliedNonOwned: true,
    allowExperimentalNonOwned: true, experimentalWriteSucceeded: true,
  });
  assert.equal(writeSucceeded.status, "WRITE_CONFIRMED_NON_OWNED");
  assert.equal(writeSucceeded.independentlyVerified, false);
});

test("SoundCloud guided ownership is explicitly user-attested, not provider-verified", () => {
  const guided = evaluatePlaylistEligibility({
    provider: "soundcloud", use: "DESTINATION", strategy: "guided",
    userConfirmedOwnerProfile: true, userConfirmedManageControl: true,
  });
  assert.deepEqual([guided.eligible, guided.status, guided.independentlyVerified], [true, "USER_ATTESTED_OWNED", false]);

  const apiMismatch = evaluatePlaylistEligibility({
    provider: "soundcloud", use: "SOURCE", strategy: "api", playlistOwnerUrn: "soundcloud:users:1",
    currentUserUrn: "soundcloud:users:2", returnedFromMePlaylists: true,
  });
  assert.deepEqual([apiMismatch.eligible, apiMismatch.reason], [false, "OWNER_MISMATCH"]);
});

function baseReceipt(): WriteReceiptBase {
  return {
    receiptId: "receipt-1",
    transferId: "transfer-1",
    destinationPlaylistId: "PL1234567890",
    target: youtubeTarget(),
    idempotencyKey: "key-1",
    writtenAt: "2026-07-29T10:02:00.000Z",
  };
}

test("VERIFIED_PROVIDER requires exact provider validation and read-after-write presence", () => {
  const base = baseReceipt();
  const validation = providerValidation(base.target);
  const receipt = createProviderVerifiedReceipt(base, validation, {
    kind: "API_READ_AFTER_WRITE",
    provider: "youtube",
    destinationPlaylistId: base.destinationPlaylistId,
    checkedAt: "2026-07-29T10:03:00.000Z",
    observedProviderEntityIds: [base.target.providerEntityId],
    evidenceVersion: "youtube-playlistItems-v1",
  });
  assert.equal(receipt.verificationStatus, "VERIFIED_PROVIDER");
  assert.equal(isIndependentlyProviderVerified(receipt), true);

  assert.throws(
    () => createProviderVerifiedReceipt(base, { status: "USER_SELECTED_UNVERIFIED" }, receipt.readAfterWrite),
    /independent target validation/,
  );
  assert.throws(
    () => createProviderVerifiedReceipt(base, validation, { ...receipt.readAfterWrite, observedProviderEntityIds: ["aaaaaaaaaaa"] }),
    /exact target ID/,
  );
  assert.throws(
    () => createProviderVerifiedReceipt(base, validation, { ...receipt.readAfterWrite, checkedAt: "2026-07-29T10:00:00.000Z" }),
    /predate/,
  );
});

test("manual confirmation remains a separate user attestation", () => {
  const base = baseReceipt();
  const manual = createUserConfirmedManualReceipt(base, {
    kind: "USER_DESTINATION_CONFIRMATION",
    provider: "youtube",
    destinationPlaylistId: base.destinationPlaylistId,
    providerEntityId: base.target.providerEntityId,
    confirmedAt: "2026-07-29T10:04:00.000Z",
    userAttestedPresent: true,
  });
  assert.equal(manual.verificationStatus, "USER_CONFIRMED_MANUAL");
  assert.equal(isIndependentlyProviderVerified(manual), false);
  assert.equal(isReportedSuccess(manual), true);

  const unverified = createUnverifiedReceipt(base, "Quota is exhausted; no read-back yet");
  assert.equal(isReportedSuccess(unverified), false);
  assert.throws(
    () => createUserConfirmedManualReceipt(base, {
      ...manual.userConfirmation,
      confirmedAt: "2026-07-29T10:01:00.000Z",
    }),
    /cannot predate/,
  );
});

test("provider validation cannot be minted for another ID", () => {
  const target = youtubeTarget();
  assert.throws(
    () => createProviderValidation(target, {
      kind: "PROVIDER_API", provider: "youtube", providerEntityId: "aaaaaaaaaaa",
      checkedAt: "2026-07-29T10:00:00Z", exists: true, evidenceVersion: "v1",
    }),
    /exact target ID/,
  );
  assert.throws(
    () => assertCandidateValidation(target, {
      status: "PROVIDER_VALIDATED",
      evidence: {
        kind: "PROVIDER_API", provider: "youtube", providerEntityId: "aaaaaaaaaaa",
        checkedAt: "2026-07-29T10:00:00Z", exists: true, evidenceVersion: "forged",
      },
    }),
    /exact target ID/,
  );
});
