import assert from "node:assert/strict";
import test from "node:test";
import { assertHonestWriteReceipt, transitionTrackItem } from "../../packages/domain/src/index.js";
import { PROVIDER_DIRECTIONS } from "../../packages/test-fixtures/gold-dataset.js";
import {
  FakeGuidedJournal,
  TRANSFER_MODES,
  runGuidedScenario,
} from "../../packages/test-fixtures/guided-harness.js";

const riskModes = ["SAFE", "RISKY"] as const;
const reviewOptions = [true, false] as const;

for (const direction of PROVIDER_DIRECTIONS) {
  for (const mode of TRANSFER_MODES) {
    for (const riskMode of riskModes) {
      for (const reviewUncertain of reviewOptions) {
        test(`${direction.join(" -> ")} | ${mode} | ${riskMode} | review=${reviewUncertain}`, () => {
          const result = runGuidedScenario({ direction, mode, riskMode, reviewUncertain });
          assert.equal(result.plan.mode, mode);
          assert.equal(result.plan.destinationProvider, direction[1]);
          assert.equal(result.plan.expectedItemWrites, 1);
          assert.equal(result.action.provider, direction[1]);
          assert.equal(result.action.kind, "ADD_ITEM");
          assert.equal(result.action.automation, "USER_OPERATED");
          assert.equal(result.action.expectedManualActions, 3);
          assert.equal(result.receipt.verificationStatus, "USER_CONFIRMED_MANUAL");
          assert.deepEqual(result.assurance, {
            category: "USER_CONFIRMED_MANUAL",
            successful: true,
            assurance: "USER_ATTESTATION_ONLY",
          });
          assert.equal(result.trackStates.at(-1), "USER_CONFIRMED_MANUAL");
          assert.equal(result.transferStates.at(-1), "COMPLETED");
          assert.equal(
            result.soundcloudExternalGate,
            direction[0] === "soundcloud" || direction[1] === "soundcloud",
          );

          const expectedUncertain = reviewUncertain
            ? "REVIEW"
            : riskMode === "SAFE"
              ? "NOT_FOUND"
              : "RISKY_MATCH";
          assert.equal(result.settingsBehavior, expectedUncertain);
        });
      }
    }
  }
}

test("write-plan idempotency and durable recovery never issue a second confirmed action", () => {
  const input = { direction: PROVIDER_DIRECTIONS[0], mode: TRANSFER_MODES[0], riskMode: "SAFE" as const, reviewUncertain: true };
  const first = runGuidedScenario(input);
  const second = runGuidedScenario(input);
  const firstKey = first.plan.destinations[0]!.items[0]!.idempotencyKey;
  const secondKey = second.plan.destinations[0]!.items[0]!.idempotencyKey;
  assert.equal(firstKey, secondKey);

  const journal = new FakeGuidedJournal();
  assert.equal(journal.issue(firstKey), "ACTION_REQUIRED");
  assert.equal(journal.issue(firstKey), "ACTION_REQUIRED", "a replay resumes the same pending action");
  const restoredPending = FakeGuidedJournal.restore(journal.serialize());
  assert.equal(restoredPending.confirm(first.receipt), first.receipt);
  const restoredConfirmed = FakeGuidedJournal.restore(restoredPending.serialize());
  assert.equal(restoredConfirmed.issue(firstKey), "ALREADY_CONFIRMED");
  assert.equal(restoredConfirmed.confirm(second.receipt).receiptId, first.receipt.receiptId);
  assert.equal(transitionTrackItem("USER_CONFIRMED_MANUAL", "USER_CONFIRMED_MANUAL"), "USER_CONFIRMED_MANUAL");
});

test("manual confirmation cannot be relabelled as provider verification", () => {
  const result = runGuidedScenario({
    direction: PROVIDER_DIRECTIONS[1],
    mode: "MERGE_NEW",
    riskMode: "SAFE",
    reviewUncertain: true,
  });
  assert.throws(() => assertHonestWriteReceipt({
    ...result.receipt,
    verificationStatus: "VERIFIED_PROVIDER",
  } as never));
  assert.throws(() => transitionTrackItem("AWAITING_USER_RECONCILIATION", "VERIFIED_PROVIDER", {
    receipt: result.receipt,
  }));
});
