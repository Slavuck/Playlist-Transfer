import { z } from "zod";
import { apiError, apiOk, requireUnlockedProfile } from "../_shared";
import { guidedCapabilities, providerLimitations, spotifyApiLimitations } from "../../../packages/connectors-core/src/policy";
import { requireCsrf, requireLocalRead } from "../../../packages/security/src/loopback-session";
import { getLocalDatabase } from "../../../packages/storage-local/src/database";
import { getLocalVault } from "../../../packages/storage-local/src/vault";
import { revokeYoutubeToken } from "../../../packages/connectors/youtube/src/oauth";
import type { YoutubeCredentials } from "../../../packages/connectors/youtube/src/client";
import { normalizeOfficialProfileUrl } from "./profile-url";

export const dynamic = "force-dynamic";

const connectSchema = z.object({
  action: z.literal("connect-guided"),
  provider: z.enum(["spotify", "soundcloud", "youtube"]),
  accountLabel: z.string().trim().min(1).max(100),
  profileUrl: z.string().url().max(2_048),
  accountTabConfirmed: z.literal(true),
});

const disconnectSchema = z.object({
  action: z.literal("disconnect"),
  provider: z.enum(["spotify", "soundcloud", "youtube"]),
  providerRevocationConfirmed: z.boolean().optional(),
});

function publicConnections() {
  return getLocalDatabase().listConnections().map((storedConnection) => {
    const { encryptedSecret, ...connection } = storedConnection;
    void encryptedSecret;
    return {
      ...connection,
      limitations: connection.provider === "spotify" && connection.strategy === "api"
        ? spotifyApiLimitations
        : providerLimitations[connection.provider],
    };
  });
}

export function GET(request: Request) {
  try {
    requireLocalRead(request);
    requireUnlockedProfile();
    return apiOk(publicConnections());
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireCsrf(request);
    requireUnlockedProfile();
    const raw = await request.json();
    const database = getLocalDatabase();
    if (raw?.action === "disconnect") {
      const input = disconnectSchema.parse(raw);
      const connection = database.getConnection(input.provider);
      if (database.listTransfers().some((transfer) => !["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(transfer.state)
        && (transfer.sourceProvider === input.provider || transfer.destinationProvider === input.provider))) {
        throw new Error("ACTIVE_PROVIDER_OPERATION");
      }
      if (input.provider === "youtube" && connection?.strategy === "api" && !input.providerRevocationConfirmed) {
        const vault = getLocalVault();
        if (!vault.isUnlocked || !connection.encryptedSecret) throw new Error("VAULT_LOCKED");
        const credentials = vault.openJson<YoutubeCredentials>(connection.encryptedSecret, "connection:youtube");
        try {
          await revokeYoutubeToken({ token: credentials.refreshToken ?? credentials.accessToken });
        } catch {
          throw new Error("YOUTUBE_REVOKE_FAILED_MANUAL_REVOCATION_REQUIRED");
        }
      }
      if (input.provider === "youtube" && connection?.strategy === "api") {
        database.deleteProviderData("youtube");
        database.audit("YOUTUBE_AUTHORIZATION_REVOKED", connection.accountId, {
          method: input.providerRevocationConfirmed ? "USER_CONFIRMED_GOOGLE_SECURITY_SETTINGS" : "GOOGLE_REVOCATION_ENDPOINT",
          relatedApiDataDeleted: true,
        });
      } else if (input.provider === "spotify" && connection?.strategy === "api") {
        database.deleteProviderData("spotify");
        database.audit("SPOTAPI_SESSION_DISCONNECTED", connection.accountId, {
          encryptedSessionCookiesDeleted: true,
          relatedApiDataDeleted: true,
          providerAuthorizationRevocationRequired: false,
        });
      } else {
        database.deleteConnection(input.provider);
      }
      return apiOk(publicConnections());
    }
    const input = connectSchema.parse(raw);
    const profileUrl = normalizeOfficialProfileUrl(input.provider, input.profileUrl);
    database.saveConnection({
      provider: input.provider,
      accountLabel: input.accountLabel,
      profileUrl,
      strategy: "guided",
      status: input.provider === "soundcloud" ? "CONNECTED_EXTERNAL_GATE_UNRESOLVED" : "CONNECTED_LIMITED",
      scopes: [],
      capabilities: guidedCapabilities[input.provider],
    });
    database.audit("GUIDED_TAB_ATTESTED", input.provider, {
      method: "USER_ATTESTED_OPEN_OFFICIAL_TAB",
      providerPasswordReceived: false,
      providerTokenReceived: false,
    });
    return apiOk(publicConnections());
  } catch (error) {
    return apiError(error);
  }
}
