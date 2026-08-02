import { createHash, randomBytes } from "node:crypto";

export const YOUTUBE_READ_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
export const YOUTUBE_WRITE_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

export type YoutubeTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  scopes: string[];
  tokenType: "Bearer";
};

export function mapYoutubeTokenError(body: Record<string, unknown>, status: number): string {
  const providerCode = typeof body.error === "string" ? body.error : String(status);
  const description = typeof body.error_description === "string" ? body.error_description : "";
  if (providerCode === "invalid_request" && /client[_ ]secret/i.test(description)) {
    if (/(?:missing|required|must (?:be )?(?:provided|set|included)).*client[_ ]secret|client[_ ]secret.*(?:missing|required|must)/i.test(description)) {
      return "YOUTUBE_OAUTH_CLIENT_SECRET_REQUIRED";
    }
    if (/client[_ ]secret.*(?:not supported|not allowed|unexpected|must not|should not)/i.test(description)) {
      return "YOUTUBE_OAUTH_CLIENT_SECRET_REJECTED";
    }
    return "YOUTUBE_OAUTH_CLIENT_SECRET_CONFIGURATION_INVALID";
  }
  if (/redirect[_ ]uri/i.test(description)) return "YOUTUBE_OAUTH_REDIRECT_URI_INVALID";
  if (/code[_ ](?:verifier|challenge)|pkce/i.test(description)) return "YOUTUBE_OAUTH_PKCE_INVALID";
  return `YOUTUBE_OAUTH_${providerCode}`;
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function createYoutubeAuthorizationRequest(input: {
  clientId: string;
  redirectUri: string;
  write: boolean;
}) {
  const verifier = randomBase64Url(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBase64Url(32);
  const scopes = input.write ? [YOUTUBE_READ_SCOPE, YOUTUBE_WRITE_SCOPE] : [YOUTUBE_READ_SCOPE];
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return { url: url.toString(), state, verifier, scopes };
}

function validateLoopbackRedirect(redirectUri: string) {
  const url = new URL(redirectUri);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new Error("YOUTUBE_REDIRECT_MUST_BE_LITERAL_LOOPBACK");
  }
}

export async function exchangeYoutubeCode(input: {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  verifier: string;
  fetchImpl?: typeof fetch;
}): Promise<YoutubeTokenSet> {
  validateLoopbackRedirect(input.redirectUri);
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: input.clientId,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
      redirect_uri: input.redirectUri,
      code: input.code,
      code_verifier: input.verifier,
      grant_type: "authorization_code",
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string") throw new Error(mapYoutubeTokenError(body, response.status));
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresAtMs: Date.now() + Number(body.expires_in ?? 3_600) * 1_000,
    scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [],
    tokenType: "Bearer",
  };
}

export async function refreshYoutubeToken(input: {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  previousScopes: string[];
  fetchImpl?: typeof fetch;
}): Promise<YoutubeTokenSet> {
  const response = await (input.fetchImpl ?? fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: input.clientId,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string") {
    const code = String(body.error ?? response.status);
    if (code === "invalid_grant") throw new Error("YOUTUBE_REAUTH_REQUIRED");
    throw new Error(`YOUTUBE_REFRESH_${code}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: input.refreshToken,
    expiresAtMs: Date.now() + Number(body.expires_in ?? 3_600) * 1_000,
    scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : input.previousScopes,
    tokenType: "Bearer",
  };
}

export async function revokeYoutubeToken(input: { token: string; fetchImpl?: typeof fetch }): Promise<void> {
  if (!input.token.trim()) throw new Error("YOUTUBE_REVOKE_TOKEN_REQUIRED");
  const response = await (input.fetchImpl ?? fetch)("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ token: input.token }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  // An already-invalid token cannot authorize further API access, so Google-side
  // revocation is already effective even if the endpoint reports HTTP 400.
  if (!response.ok && response.status !== 400) throw new Error("YOUTUBE_REVOKE_FAILED");
}
