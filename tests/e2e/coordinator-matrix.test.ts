import assert from "node:assert/strict";
import test from "node:test";
import {
  createCoordinatorHarness,
  createMatrixTransfer,
} from "../../packages/test-fixtures/coordinator-matrix-harness.js";
import { PROVIDER_DIRECTIONS } from "../../packages/test-fixtures/gold-dataset.js";
import { TRANSFER_MODES } from "../../packages/test-fixtures/guided-harness.js";
import type { TransferCoordinator } from "../../packages/orchestrator/src/coordinator.js";
import type { JsonObject } from "../../packages/storage-local/src/database.js";

type CoordinatorView = ReturnType<TransferCoordinator["view"]>;

const riskModes = ["SAFE", "RISKY"] as const;
const reviewOptions = [true, false] as const;

function includesSoundcloud(direction: (typeof PROVIDER_DIRECTIONS)[number]): boolean {
  return direction[0] === "soundcloud" || direction[1] === "soundcloud";
}

for (const direction of PROVIDER_DIRECTIONS) {
  for (const mode of TRANSFER_MODES) {
    for (const riskMode of riskModes) {
      for (const reviewUncertain of reviewOptions) {
        test(`coordinator ${direction.join(" -> ")} | ${mode} | ${riskMode} | review=${reviewUncertain}`, async () => {
          const harness = createCoordinatorHarness(direction);
          try {
            const coordinator = harness.coordinator();
            const transfer = createMatrixTransfer(coordinator, harness, {
              direction,
              mode,
              riskMode,
              reviewUncertain,
            });
            const persistedSettings = transfer.settings.matching as JsonObject;
            assert.equal(persistedSettings.riskMode, riskMode);
            assert.equal(persistedSettings.reviewUncertain, reviewUncertain);

            let view = await coordinator.start(transfer.id) as CoordinatorView;
            if (includesSoundcloud(direction)) {
              assert.ok(view.limitations.includes("SC-BASE-LEGAL_EXTERNAL_UNKNOWN"));
              assert.ok(view.limitations.includes("SC-BASE-LEGAL_MANUAL_ONLY"));
              assert.equal(view.externalGate?.status, "MANUAL_ONLY");
              assert.equal(view.capabilities.soundcloudTransfer, "guided-manual-only");

              const audits = harness.database.all<JsonObject>(
                "SELECT event_type, detail_json FROM audit_events WHERE subject_id = ? ORDER BY id",
                transfer.id,
              );
              const gateAudit = audits.find((entry) => entry.event_type === "TRANSFER_MANUAL_ONLY_POLICY_GATE");
              assert.ok(gateAudit, "SC-BASE-LEGAL manual-only decision must be auditable");
              const detail = JSON.parse(String(gateAudit.detail_json)) as JsonObject;
              assert.equal(detail.gate, "SC-BASE-LEGAL");
              assert.equal(detail.status, "UNKNOWN");
              assert.equal(detail.applicationAutomationEnabled, false);
              assert.equal(detail.userOperatedGuidedPathEnabled, true);
            }

            if (!reviewUncertain) {
              assert.equal(view.transfer.state, "PARTIAL");
              assert.equal(view.items.length, 1);
              assert.equal(view.items[0]!.state, "SKIPPED_NOT_FOUND");
              assert.ok(view.items[0]!.riskFlags.includes(
                riskMode === "SAFE" ? "SAFE_SKIPPED_UNCERTAIN_REVIEW_DISABLED" : "RISKY_NO_POLICY_COMPLIANT_AUTO_CANDIDATE",
              ));
              assert.ok(view.limitations.includes("UNCERTAIN_ITEMS_SKIP_WHEN_REVIEW_DISABLED"));
              assert.ok(view.limitations.includes("NO_ITEMS_SELECTED_FOR_WRITE"));
              assert.equal(view.bindingNeeds.length, 0);
              assert.equal(view.pendingAction, undefined);
              assert.equal(view.transfer.writePlan, undefined);
              assert.equal(harness.database.listReceipts(transfer.id).length, 0);
              return;
            }

            assert.equal(view.transfer.state, "NEEDS_REVIEW");
            assert.equal(view.items.length, 1);
            assert.equal(view.items[0]!.state, "NEEDS_REVIEW");
            assert.equal(harness.database.listReceipts(transfer.id).length, 0);
            const initialJournal = harness.database.listJournal(transfer.id);
            assert.ok(initialJournal.some((entry) => entry.stepKind === "PREFLIGHT" && entry.status === "COMPLETED"));
            assert.ok(initialJournal.some((entry) => entry.stepKind === "SNAPSHOT" && entry.status === "COMPLETED"));

            const itemId = view.items[0]!.id;
            view = await coordinator.review(transfer.id, {
              action: "select",
              itemId,
              target: harness.targetTrackUrl,
            }) as CoordinatorView;
            if (includesSoundcloud(direction)) {
              assert.equal(view.items[0]!.selection?.writeStrategy, "GUIDED_USER_ACTION");
            }

            if (mode !== "APPEND_EXISTING") {
              assert.equal(view.transfer.state, "NEEDS_REVIEW");
              assert.equal(view.bindingNeeds.length, 1);
              assert.equal(view.pendingAction?.kind, "CREATE_PLAYLIST");
              view = await coordinator.bindDestination(transfer.id, {
                planKey: view.bindingNeeds[0]!.planKey,
                playlistUrl: harness.destinationPlaylistUrl,
                ownershipAttested: true,
                editControlAttested: true,
                newPlaylistAttested: true,
                visibleItemCount: 0,
              }) as CoordinatorView;
            }
            assert.equal(view.transfer.state, "READY_TO_WRITE");
            assert.equal(view.items[0]!.state, "WRITE_PENDING");
            assert.ok(view.transfer.writePlan, "coordinator must persist an immutable write plan");

            view = await coordinator.runNext(transfer.id) as CoordinatorView;
            assert.equal(view.transfer.state, "WRITING");
            assert.equal(view.items[0]!.state, "AWAITING_USER_RECONCILIATION");
            assert.equal(view.pendingAction?.kind, "ADD_ITEM");
            assert.equal(view.pendingAction?.automation, "USER_OPERATED");
            if (includesSoundcloud(direction)) {
              assert.equal(view.capabilities.soundcloudTransfer, "guided-manual-only");
            }
            assert.equal(view.pendingAction?.requiresFreshDestinationConfirmation, true);
            assert.equal(view.pendingAction?.expectedDestinationItemCount, 0);
            assert.equal(
              view.pendingAction?.destinationBaselineKind,
              mode === "APPEND_EXISTING" ? "EXISTING_SNAPSHOT" : "NEW_EMPTY_AT_BINDING",
            );
            assert.equal(view.pendingAction?.confirmedPriorAdds, 0);
            assert.equal(harness.database.listReceipts(transfer.id).length, 0);
            const awaiting = harness.database.listJournal(transfer.id).find(
              (entry) => entry.stepKind === "GUIDED_ADD" && entry.status === "AWAITING_USER",
            );
            assert.ok(awaiting, "guided mutation must pause on a durable reconciliation journal entry");

            const restarted = harness.coordinator();
            const resumed = restarted.view(transfer.id);
            assert.equal(resumed.pendingAction?.id, view.pendingAction?.id, "restart must resume the same action card");
            view = await restarted.reconcile(transfer.id, { itemId, result: "present" }) as CoordinatorView;

            assert.equal(view.transfer.state, "COMPLETED");
            assert.equal(view.items[0]!.state, "USER_CONFIRMED_MANUAL");
            assert.equal(view.report.counts.USER_CONFIRMED_MANUAL, 1);
            assert.equal(view.report.counts.VERIFIED_PROVIDER, 0);
            assert.equal(view.report.independentlyVerified, 0);
            assert.equal(view.report.userConfirmedOnly, 1);
            const receipts = harness.database.listReceipts(transfer.id);
            assert.equal(receipts.length, 1);
            assert.equal(receipts[0]!.verificationStatus, "USER_CONFIRMED_MANUAL");
            assert.equal(receipts[0]!.manual, true);
            assert.ok(harness.database.listJournal(transfer.id).some(
              (entry) => entry.stepKind === "GUIDED_ADD" && entry.status === "USER_CONFIRMED_PRESENT",
            ));
          } finally {
            harness.dispose();
          }
        });
      }
    }
  }
}
