import { NextResponse } from "next/server";
import { YoutubeApiClient, type YoutubeCredentials } from "../../../../../packages/connectors/youtube/src/client";
import { exchangeYoutubeCode } from "../../../../../packages/connectors/youtube/src/oauth";
import { youtubeApiCapabilities, providerLimitations } from "../../../../../packages/connectors-core/src/policy";
import { assertLoopbackRequest, LOCAL_ORIGIN, rateLimit } from "../../../../../packages/security/src/loopback-session";
import { claimYoutubeOAuthState } from "../../../../../packages/security/src/oauth-state";
import { getLocalDatabase } from "../../../../../packages/storage-local/src/database";
import { getLocalVault } from "../../../../../packages/storage-local/src/vault";
import { isYoutubeApiReleaseEnabled } from "../../../../../packages/connectors-core/src/policy";

export const dynamic = "force-dynamic";

function connectionRedirect(code: string) {
  const url = new URL("/connections", LOCAL_ORIGIN);
  url.searchParams.set("youtube", code);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  try {
    assertLoopbackRequest(request);
    rateLimit("youtube-oauth-callback", 10, 60_000);
    const url = new URL(request.url);
    const stateValue = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const providerError = url.searchParams.get("error");
    if (providerError) return connectionRedirect(`error:${providerError}`);
    if (!stateValue || !code) throw new Error("YOUTUBE_OAUTH_CALLBACK_INVALID");
    const state = claimYoutubeOAuthState(stateValue);
    if (!state) throw new Error("YOUTUBE_OAUTH_STATE_INVALID_OR_EXPIRED");
    if (!isYoutubeApiReleaseEnabled()) throw new Error("YOUTUBE_API_POLICY_GATE_CLOSED");
    const vault = getLocalVault();
    if (!vault.isUnlocked) throw new Error("VAULT_LOCKED");
    const tokens = await exchangeYoutubeCode({
      clientId: state.clientId,
      redirectUri: state.redirectUri,
      code,
      verifier: state.verifier,
    });
    const credentials: YoutubeCredentials = { ...tokens, clientId: state.clientId };
    const client = new YoutubeApiClient(credentials);
    const account = await client.getCurrentAccount();
    credentials.channelId = account.channelId;
    getLocalDatabase().saveConnection({
      provider: "youtube",
      accountId: account.channelId,
      accountLabel: account.title,
      profileUrl: `https://www.youtube.com/channel/${account.channelId}`,
      strategy: "api",
      status: "CONNECTED",
      scopes: tokens.scopes,
      capabilities: {
        ...youtubeApiCapabilities,
        limitations: providerLimitations.youtube,
        policyAcceptanceVersion: state.policyVersion,
        policyAcceptedAtMs: state.policyAcceptedAtMs,
      },
      encryptedSecret: vault.sealJson(credentials, "connection:youtube"),
      authorizedAtMs: Date.now(),
      expiresAtMs: tokens.expiresAtMs,
    });
    getLocalDatabase().audit("YOUTUBE_OAUTH_CONNECTED", account.channelId, { scopes: tokens.scopes, providerPasswordReceived: false });
    return connectionRedirect("connected");
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    return connectionRedirect(`error:${code}`);
  }
}
