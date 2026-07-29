import { getLocalDatabase } from "../../../storage-local/src/database";
import { getLocalVault } from "../../../storage-local/src/vault";
import { YoutubeApiClient, createYoutubeQuotaUse, type YoutubeCredentials } from "./client";
import { isYoutubeApiReleaseEnabled } from "../../../connectors-core/src/policy";

export function loadLocalYoutubeClient(): YoutubeApiClient {
  if (typeof window !== "undefined") throw new Error("YOUTUBE_CLIENT_SERVER_ONLY");
  if (!isYoutubeApiReleaseEnabled()) throw new Error("YOUTUBE_API_POLICY_GATE_CLOSED");
  const database = getLocalDatabase();
  const vault = getLocalVault();
  if (!vault.isUnlocked) throw new Error("VAULT_LOCKED");
  const connection = database.getConnection("youtube");
  if (!connection || connection.strategy !== "api" || !connection.encryptedSecret) throw new Error("YOUTUBE_API_NOT_CONNECTED");
  if (connection.status === "REAUTH_REQUIRED") throw new Error("YOUTUBE_REAUTH_REQUIRED");
  const credentials = vault.openJson<YoutubeCredentials>(connection.encryptedSecret, "connection:youtube");
  return new YoutubeApiClient(credentials, {
    quotaUse: createYoutubeQuotaUse(database),
    onTokenRefresh: (updated) => {
      database.saveConnection({
        ...connection,
        encryptedSecret: vault.sealJson(updated, "connection:youtube"),
        expiresAtMs: updated.expiresAtMs,
        status: "CONNECTED",
      });
    },
    onReauthRequired: () => {
      database.saveConnection({ ...connection, status: "REAUTH_REQUIRED" });
    },
  });
}
