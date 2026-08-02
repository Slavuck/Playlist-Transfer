import { createHash, randomBytes } from "node:crypto";
import type { HostedConfig, HostedProvider } from "./config";
import { providerCallbackUrl } from "./config";
import type { HostedTokenSet } from "./session";

const SPOTIFY_SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-read-private",
];
const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

function base64Url(bytes = 48): string {
  return randomBytes(bytes).toString("base64url");
}

export function createHostedAuthorization(config: HostedConfig, provider: HostedProvider) {
  const verifier = base64Url(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = base64Url(32);
  const callback = providerCallbackUrl(config, provider);
  const url = new URL(provider === "spotify" ? "https://accounts.spotify.com/authorize" : "https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", provider === "spotify" ? config.spotifyClientId : config.youtubeClientId);
  url.searchParams.set("redirect_uri", callback);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (provider === "spotify" ? SPOTIFY_SCOPES : YOUTUBE_SCOPES).join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (provider === "youtube") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
  }
  return { url: url.toString(), state, verifier };
}

async function tokenRequest(url: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    const code = typeof payload.error === "string" ? payload.error : String(response.status);
    throw new Error(`HOSTED_OAUTH_TOKEN_${code}`);
  }
  return payload;
}

function toTokenSet(payload: Record<string, unknown>, fallbackRefreshToken?: string, fallbackScopes: string[] = []): HostedTokenSet {
  return {
    accessToken: String(payload.access_token),
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : fallbackRefreshToken,
    expiresAtMs: Date.now() + Math.max(60, Number(payload.expires_in ?? 3_600)) * 1_000,
    scopes: typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : fallbackScopes,
    tokenType: "Bearer",
  };
}

export async function exchangeHostedCode(input: {
  config: HostedConfig;
  provider: HostedProvider;
  code: string;
  verifier: string;
}): Promise<HostedTokenSet> {
  const callback = providerCallbackUrl(input.config, input.provider);
  if (input.provider === "spotify") {
    const payload = await tokenRequest("https://accounts.spotify.com/api/token", new URLSearchParams({
      client_id: input.config.spotifyClientId,
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: callback,
      code_verifier: input.verifier,
    }));
    return toTokenSet(payload, undefined, SPOTIFY_SCOPES);
  }
  const payload = await tokenRequest("https://oauth2.googleapis.com/token", new URLSearchParams({
    client_id: input.config.youtubeClientId,
    ...(input.config.youtubeClientSecret ? { client_secret: input.config.youtubeClientSecret } : {}),
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: callback,
    code_verifier: input.verifier,
  }));
  return toTokenSet(payload, undefined, YOUTUBE_SCOPES);
}

export async function refreshHostedToken(
  config: HostedConfig,
  provider: HostedProvider,
  token: HostedTokenSet,
): Promise<HostedTokenSet> {
  if (!token.refreshToken) throw new Error(`${provider.toUpperCase()}_REAUTH_REQUIRED`);
  const payload = provider === "spotify"
    ? await tokenRequest("https://accounts.spotify.com/api/token", new URLSearchParams({
        client_id: config.spotifyClientId,
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
      }))
    : await tokenRequest("https://oauth2.googleapis.com/token", new URLSearchParams({
        client_id: config.youtubeClientId,
        ...(config.youtubeClientSecret ? { client_secret: config.youtubeClientSecret } : {}),
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
      }));
  return toTokenSet(payload, token.refreshToken, token.scopes);
}
