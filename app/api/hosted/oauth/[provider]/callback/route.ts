import { NextResponse } from "next/server";
import { getHostedConfig, type HostedProvider } from "@/packages/hosted/src/config";
import { exchangeHostedCode } from "@/packages/hosted/src/oauth";
import { secureEquals } from "@/packages/hosted/src/crypto";
import { takeOAuthAttempt, writeProviderToken } from "@/packages/hosted/src/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function providerValue(value: string): HostedProvider {
  if (value !== "spotify" && value !== "youtube") throw new Error("HOSTED_PROVIDER_INVALID");
  return value;
}

function redirectHome(origin: string, provider: string, status: "connected" | "error", code?: string): NextResponse {
  const url = new URL("/", origin);
  url.searchParams.set("oauth", provider);
  url.searchParams.set("status", status);
  if (code) url.searchParams.set("code", code.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100));
  return NextResponse.redirect(url, { status: 302 });
}

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  let origin = new URL(request.url).origin;
  let provider = "unknown";
  try {
    provider = providerValue((await context.params).provider);
    const config = getHostedConfig(request.url);
    origin = config.origin;
    const url = new URL(request.url);
    const providerError = url.searchParams.get("error");
    if (providerError) throw new Error(`HOSTED_OAUTH_${providerError}`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) throw new Error("HOSTED_OAUTH_CALLBACK_INVALID");
    const attempt = await takeOAuthAttempt(config);
    if (!attempt || attempt.provider !== provider || !secureEquals(attempt.state, state)) {
      throw new Error("HOSTED_OAUTH_STATE_MISMATCH");
    }
    const token = await exchangeHostedCode({ config, provider, code, verifier: attempt.verifier });
    await writeProviderToken(provider, token, config);
    return redirectHome(origin, provider, "connected");
  } catch (error) {
    const code = error instanceof Error ? error.message : "HOSTED_OAUTH_FAILED";
    return redirectHome(origin, provider, "error", code);
  }
}
