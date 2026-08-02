import { cookies } from "next/headers";
import { openValue, sealValue } from "./crypto";
import type { HostedConfig, HostedProvider } from "./config";

export type HostedTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  scopes: string[];
  tokenType: "Bearer";
};

export type OAuthAttempt = {
  provider: HostedProvider;
  state: string;
  verifier: string;
  issuedAtMs: number;
};

const TOKEN_COOKIE: Record<HostedProvider, string> = {
  spotify: "pt_hosted_spotify",
  youtube: "pt_hosted_youtube",
};
const OAUTH_COOKIE = "pt_hosted_oauth";

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
    priority: "high" as const,
  };
}

function validToken(value: HostedTokenSet | null): value is HostedTokenSet {
  return Boolean(
    value &&
      typeof value.accessToken === "string" &&
      typeof value.expiresAtMs === "number" &&
      Array.isArray(value.scopes),
  );
}

export async function readProviderToken(provider: HostedProvider, config: HostedConfig): Promise<HostedTokenSet | null> {
  const value = (await cookies()).get(TOKEN_COOKIE[provider])?.value;
  if (!value) return null;
  const token = openValue<HostedTokenSet>(value, config.secret);
  return validToken(token) ? token : null;
}

export async function writeProviderToken(provider: HostedProvider, token: HostedTokenSet, config: HostedConfig): Promise<void> {
  (await cookies()).set(TOKEN_COOKIE[provider], sealValue(token, config.secret), cookieOptions(60 * 60 * 24 * 30));
}

export async function clearProviderToken(provider: HostedProvider): Promise<void> {
  (await cookies()).set(TOKEN_COOKIE[provider], "", { ...cookieOptions(0), expires: new Date(0) });
}

export async function writeOAuthAttempt(attempt: OAuthAttempt, config: HostedConfig): Promise<void> {
  (await cookies()).set(OAUTH_COOKIE, sealValue(attempt, config.secret), cookieOptions(10 * 60));
}

export async function takeOAuthAttempt(config: HostedConfig): Promise<OAuthAttempt | null> {
  const store = await cookies();
  const value = store.get(OAUTH_COOKIE)?.value;
  store.set(OAUTH_COOKIE, "", { ...cookieOptions(0), expires: new Date(0) });
  if (!value) return null;
  const attempt = openValue<OAuthAttempt>(value, config.secret);
  if (
    !attempt ||
    !["spotify", "youtube"].includes(attempt.provider) ||
    typeof attempt.state !== "string" ||
    typeof attempt.verifier !== "string" ||
    typeof attempt.issuedAtMs !== "number" ||
    Date.now() - attempt.issuedAtMs > 10 * 60 * 1_000
  ) return null;
  return attempt;
}
