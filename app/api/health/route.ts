import { apiError, apiOk } from "../_shared";
import { requireLocalRead } from "../../../packages/security/src/loopback-session";
import { getLocalDatabase } from "../../../packages/storage-local/src/database";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    requireLocalRead(request);
    const database = getLocalDatabase();
    database.cleanupExpired();
    return apiOk({ status: "healthy", storage: "sqlite", database: "local-app-data", hostedDependencies: false, loopbackOnly: true });
  } catch (error) {
    return apiError(error);
  }
}
