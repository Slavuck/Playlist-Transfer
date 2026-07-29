import { apiError, apiOk, requireUnlockedProfile } from "../../../_shared";
import { requireLocalRead } from "../../../../../packages/security/src/loopback-session";
import { getTransferCoordinator } from "../../../../../packages/orchestrator/src/coordinator";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireLocalRead(request);
    requireUnlockedProfile();
    const { id } = await context.params;
    const view = getTransferCoordinator().view(id) as { report: unknown; transfer: unknown; limitations: unknown };
    return apiOk({ transfer: view.transfer, report: view.report, limitations: view.limitations });
  } catch (error) {
    return apiError(error);
  }
}
