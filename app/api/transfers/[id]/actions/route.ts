import { z } from "zod";
import { apiError, apiOk, requireUnlockedProfile } from "../../../_shared";
import { requireCsrf } from "../../../../../packages/security/src/loopback-session";
import { getTransferCoordinator } from "../../../../../packages/orchestrator/src/coordinator";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("run-next") }),
  z.object({ action: z.literal("cancel") }),
  z.object({
    action: z.literal("bind-destination"),
    planKey: z.string().min(1).max(1_000),
    playlistUrl: z.string().url().max(2_048),
    title: z.string().max(300).optional(),
    ownershipAttested: z.literal(true),
    editControlAttested: z.literal(true),
    newPlaylistAttested: z.literal(true),
    visibleItemCount: z.literal(0),
  }),
  z.object({ action: z.literal("reconcile"), itemId: z.string().min(1).max(128), result: z.enum(["present", "absent", "unknown"]) }),
]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireCsrf(request);
    requireUnlockedProfile();
    const { id } = await context.params;
    const input = actionSchema.parse(await request.json());
    const coordinator = getTransferCoordinator();
    if (input.action === "start") return apiOk(await coordinator.start(id));
    if (input.action === "run-next") return apiOk(await coordinator.runNext(id));
    if (input.action === "cancel") return apiOk(await coordinator.cancel(id));
    if (input.action === "bind-destination") return apiOk(await coordinator.bindDestination(id, input));
    return apiOk(await coordinator.reconcile(id, input));
  } catch (error) {
    return apiError(error);
  }
}
