import { apiError, apiOk, requireUnlockedProfile } from "../../_shared";
import { requireLocalRead } from "../../../../packages/security/src/loopback-session";
import { getTransferCoordinator } from "../../../../packages/orchestrator/src/coordinator";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireLocalRead(request);
    requireUnlockedProfile();
    const { id } = await context.params;
    return apiOk(getTransferCoordinator().view(id));
  } catch (error) {
    return apiError(error);
  }
}
