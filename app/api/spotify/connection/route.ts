import { z } from "zod";
import { apiError, apiOk, requireUnlockedProfile } from "../../_shared";
import { SpotifyApiClient, type SpotifyCredentials } from "../../../../packages/connectors/spotify/src/client";
import { getSpotApiDiagnostic } from "../../../../packages/connectors/spotify/src/bridge";
import { parseSpotApiCookies } from "../../../../packages/connectors/spotify/src/cookies";
import {
  isSpotifyApiReleaseEnabled,
  POLICY_VERSION,
  spotifyApiCapabilities,
  spotifyApiLimitations,
} from "../../../../packages/connectors-core/src/policy";
import { rateLimit, requireCsrf, requireLocalRead } from "../../../../packages/security/src/loopback-session";
import { getLocalDatabase } from "../../../../packages/storage-local/src/database";
import { getLocalVault } from "../../../../packages/storage-local/src/vault";

export const dynamic = "force-dynamic";

const connectSchema = z.object({
  cookieHeader: z.string().trim().min(12).max(32_768),
  localPrivacyAccepted: z.literal(true),
  providerPoliciesAccepted: z.literal(true),
});

export async function GET(request: Request) {
  try {
    requireLocalRead(request);
    const diagnostic = await getSpotApiDiagnostic();
    return apiOk({ ...diagnostic, policyGateEnabled: isSpotifyApiReleaseEnabled() });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireCsrf(request);
    requireUnlockedProfile();
    rateLimit("spotapi-connect", 5, 60_000);
    if (!isSpotifyApiReleaseEnabled()) throw new Error("SPOTAPI_POLICY_GATE_CLOSED");
    const input = connectSchema.parse(await request.json());
    const vault = getLocalVault();
    if (!vault.isUnlocked) throw new Error("VAULT_LOCKED");
    const credentials: SpotifyCredentials = {
      identifier: "playlist-transfer-local",
      cookies: parseSpotApiCookies(input.cookieHeader),
      connectedAtMs: Date.now(),
    };
    const account = await new SpotifyApiClient(credentials).getCurrentAccount();
    const database = getLocalDatabase();
    database.saveConnection({
      provider: "spotify",
      accountId: account.accountId,
      accountLabel: account.displayName,
      profileUrl: account.profileUrl,
      strategy: "api",
      status: "CONNECTED",
      scopes: ["spotapi:library-read", "spotapi:playlist-modify"],
      capabilities: {
        ...spotifyApiCapabilities,
        limitations: spotifyApiLimitations,
        connector: "spotapi",
        spotApiPolicyAcceptanceVersion: POLICY_VERSION,
        spotApiPolicyAcceptedAtMs: Date.now(),
      },
      encryptedSecret: vault.sealJson(credentials, "connection:spotify"),
      authorizedAtMs: Date.now(),
    });
    database.audit("SPOTAPI_SESSION_CONNECTED", account.accountId, {
      cookieNames: Object.keys(credentials.cookies),
      providerPasswordReceived: false,
      providerCookieStoredEncrypted: true,
    });
    return apiOk({
      connection: {
        provider: "spotify",
        accountId: account.accountId,
        accountLabel: account.displayName,
        profileUrl: account.profileUrl,
        strategy: "api",
        status: "CONNECTED",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
