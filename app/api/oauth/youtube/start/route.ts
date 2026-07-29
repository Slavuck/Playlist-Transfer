import { z } from "zod";
import { apiError, apiOk, requireUnlockedProfile } from "../../../_shared";
import { createYoutubeAuthorizationRequest } from "../../../../../packages/connectors/youtube/src/oauth";
import { LOCAL_ORIGIN, rateLimit, requireCsrf } from "../../../../../packages/security/src/loopback-session";
import { storeYoutubeOAuthState } from "../../../../../packages/security/src/oauth-state";
import { getLocalVault } from "../../../../../packages/storage-local/src/vault";
import { isYoutubeApiReleaseEnabled, POLICY_VERSION } from "../../../../../packages/connectors-core/src/policy";

const inputSchema = z.object({
  clientId: z.string().trim().min(20).max(300).regex(/\.apps\.googleusercontent\.com$/).optional(),
  write: z.boolean().default(true),
  localPrivacyAccepted: z.literal(true),
  providerPoliciesAccepted: z.literal(true),
});

export async function POST(request: Request) {
  try {
    requireCsrf(request);
    requireUnlockedProfile();
    rateLimit("youtube-oauth-start", 5, 60_000);
    if (!isYoutubeApiReleaseEnabled()) throw new Error("YOUTUBE_API_POLICY_GATE_CLOSED");
    if (!getLocalVault().isUnlocked) throw new Error("VAULT_LOCKED");
    const input = inputSchema.parse(await request.json());
    const clientId = input.clientId ?? process.env.PLAYLIST_TRANSFER_YOUTUBE_CLIENT_ID?.trim();
    if (!clientId || !/\.apps\.googleusercontent\.com$/u.test(clientId)) throw new Error("YOUTUBE_OAUTH_MAINTAINER_SETUP_REQUIRED");
    const redirectUri = `${LOCAL_ORIGIN}/api/oauth/youtube/callback`;
    const auth = createYoutubeAuthorizationRequest({ ...input, clientId, redirectUri });
    storeYoutubeOAuthState({
      state: auth.state,
      verifier: auth.verifier,
      clientId,
      redirectUri,
      scopes: auth.scopes,
      policyVersion: POLICY_VERSION,
      policyAcceptedAtMs: Date.now(),
      expiresAtMs: Date.now() + 10 * 60 * 1000,
    });
    return apiOk({ authorizationUrl: auth.url, expiresInSeconds: 600, fullReauthorization: true });
  } catch (error) {
    return apiError(error);
  }
}
