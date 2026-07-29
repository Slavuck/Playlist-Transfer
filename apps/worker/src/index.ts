import { getTransferCoordinator } from "../../../packages/orchestrator/src/coordinator";
import path from "node:path";
import { pathToFileURL } from "node:url";

type WorkerView = {
  transfer: { id: string; state: string };
  items: Array<{ state: string; selection?: { writeStrategy?: string } }>;
  pendingAction?: { kind?: string };
};

function canAdvanceWithoutOpeningTheVault(view: WorkerView): boolean {
  if (view.pendingAction) return false;
  if (view.transfer.state !== "READY_TO_WRITE" && view.transfer.state !== "WRITING") return false;
  const next = view.items.find((item) => item.state === "WRITE_PENDING");
  return !next || next.selection?.writeStrategy === "GUIDED_USER_ACTION";
}

export async function runWorkerTick(): Promise<{ inspected: number; advanced: number; paused: number }> {
  const coordinator = getTransferCoordinator();
  const resumableStates = ["PREFLIGHT", "SNAPSHOTTING", "MATCHING"];
  const active = coordinator.list().filter((transfer) => [...resumableStates, "READY_TO_WRITE", "WRITING"].includes(transfer.state));
  let advanced = 0;
  let paused = 0;
  for (const transfer of active) {
    if (resumableStates.includes(transfer.state)) {
      await coordinator.start(transfer.id);
      advanced += 1;
      continue;
    }
    const view = coordinator.view(transfer.id) as WorkerView;
    if (!canAdvanceWithoutOpeningTheVault(view)) {
      paused += 1;
      continue;
    }
    await coordinator.runNext(transfer.id);
    advanced += 1;
  }
  return { inspected: active.length, advanced, paused };
}

async function main() {
  const watch = process.argv.includes("--watch");
  do {
    const result = await runWorkerTick();
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
    if (!watch) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (true);
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "WORKER_FAILED"}\n`);
    process.exitCode = 1;
  });
}
