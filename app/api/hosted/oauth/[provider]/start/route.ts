import { NextResponse } from "next/server";
import { getHostedConfig, type HostedProvider } from "@/packages/hosted/src/config";
import { createHostedAuthorization } from "@/packages/hosted/src/oauth";
import { writeOAuthAttempt } from "@/packages/hosted/src/session";
import { hostedError } from "@/packages/hosted/src/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function providerValue(value: string): HostedProvider {
  if (value !== "spotify" && value !== "youtube") throw new Error("HOSTED_PROVIDER_INVALID");
  return value;
}

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  try {
    const provider = providerValue((await context.params).provider);
    const config = getHostedConfig(request.url);
    const authorization = createHostedAuthorization(config, provider);
    await writeOAuthAttempt({
      provider,
      state: authorization.state,
      verifier: authorization.verifier,
      issuedAtMs: Date.now(),
    }, config);
    return NextResponse.redirect(authorization.url, { status: 302 });
  } catch (error) {
    return hostedError(error);
  }
}
