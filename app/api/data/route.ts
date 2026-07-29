import { z } from "zod";
import { apiError, apiOk, requireUnlockedProfile } from "../_shared";
import { policyGates, POLICY_VERSION, providerLimitations } from "../../../packages/connectors-core/src/policy";
import { requireCsrf } from "../../../packages/security/src/loopback-session";
import { getLocalDatabase } from "../../../packages/storage-local/src/database";
import { createPortableEncryptedBackup, getLocalVault, redactSecrets } from "../../../packages/storage-local/src/vault";
import { revokeYoutubeToken } from "../../../packages/connectors/youtube/src/oauth";
import type { YoutubeCredentials } from "../../../packages/connectors/youtube/src/client";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("clear-history") }),
  z.object({ action: z.literal("delete-account"), googleRevocationConfirmed: z.boolean().optional() }),
  z.object({ action: z.literal("export-backup"), backupPassphrase: z.string().min(10).max(512) }),
  z.object({ action: z.literal("diagnostics") }),
]);

export async function POST(request: Request) {
  try {
    requireCsrf(request);
    requireUnlockedProfile();
    const input = actionSchema.parse(await request.json());
    const database = getLocalDatabase();
    const vault = getLocalVault();
    if (input.action === "clear-history") {
      database.clearHistory();
      return apiOk({ cleared: true });
    }
    if (input.action === "delete-account") {
      if (database.listTransfers().some((transfer) => !["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(transfer.state))) {
        throw new Error("ACTIVE_PROVIDER_OPERATION");
      }
      const youtube = database.getConnection("youtube");
      if (youtube?.strategy === "api" && !input.googleRevocationConfirmed) {
        if (!vault.isUnlocked || !youtube.encryptedSecret) throw new Error("VAULT_LOCKED");
        const credentials = vault.openJson<YoutubeCredentials>(youtube.encryptedSecret, "connection:youtube");
        try {
          await revokeYoutubeToken({ token: credentials.refreshToken ?? credentials.accessToken });
        } catch {
          throw new Error("YOUTUBE_REVOKE_FAILED_MANUAL_REVOCATION_REQUIRED");
        }
      }
      database.wipeAll();
      vault.lock();
      return apiOk({ deleted: true });
    }
    if (input.action === "diagnostics") {
      return apiOk(redactSecrets({
        generatedAt: new Date().toISOString(),
        edition: "local-guided-zero-budget",
        telemetry: false,
        connections: database.listConnections().map((storedConnection) => {
          const { encryptedSecret, ...connection } = storedConnection;
          void encryptedSecret;
          return connection;
        }),
        transfers: database.listTransfers().map((transfer) => ({ id: transfer.id, state: transfer.state, sourceProvider: transfer.sourceProvider, destinationProvider: transfer.destinationProvider, updatedAtMs: transfer.updatedAtMs })),
        policyVersion: POLICY_VERSION,
        policyGates,
        providerLimitations,
      }));
    }
    if (!vault.isUnlocked) throw new Error("VAULT_LOCKED");
    const connections = database.listConnections().map((connection) => ({
      ...connection,
      secret: connection.encryptedSecret
        ? vault.openJson(connection.encryptedSecret, `connection:${connection.provider}`)
        : undefined,
      encryptedSecret: undefined,
    }));
    const profile = database.getProfile();
    const backup = createPortableEncryptedBackup({
      exportedAtMs: Date.now(),
      profile: profile ? { displayName: profile.displayName, language: profile.language } : undefined,
      connections,
    }, input.backupPassphrase);
    return apiOk({
      filename: `playlist-transfer-backup-${new Date().toISOString().slice(0, 10)}.json`,
      contentBase64: Buffer.from(backup, "utf8").toString("base64"),
    });
  } catch (error) {
    return apiError(error);
  }
}
