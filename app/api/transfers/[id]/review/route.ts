import { z } from "zod";
import { apiError, apiOk, requireUnlockedProfile } from "../../../_shared";
import { requireCsrf } from "../../../../../packages/security/src/loopback-session";
import { getTransferCoordinator } from "../../../../../packages/orchestrator/src/coordinator";

const reviewSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("auto-match") }),
  z.object({
    action: z.literal("select"),
    itemId: z.string().min(1).max(128),
    target: z.union([z.string().min(1).max(2_048), z.record(z.string(), z.unknown())]).optional(),
    targetUrl: z.string().url().max(2_048).optional(),
  }).refine((value) => value.target !== undefined || value.targetUrl !== undefined, "TARGET_REQUIRED"),
  z.object({ action: z.literal("skip"), itemId: z.string().min(1).max(128) }),
  z.object({
    action: z.literal("stage-candidates"),
    itemId: z.string().min(1).max(128),
    targets: z.array(z.string().url().max(2_048)).min(3).max(5),
  }),
]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireCsrf(request);
    requireUnlockedProfile();
    const { id } = await context.params;
    const input = reviewSchema.parse(await request.json());
    if (input.action === "auto-match") return apiOk(await getTransferCoordinator().autoResolveReview(id));
    return apiOk(await getTransferCoordinator().review(id, {
      action: input.action,
      itemId: input.itemId,
      target: input.action === "select" ? input.target ?? input.targetUrl : undefined,
      targets: input.action === "stage-candidates" ? input.targets : undefined,
    }));
  } catch (error) {
    return apiError(error);
  }
}
