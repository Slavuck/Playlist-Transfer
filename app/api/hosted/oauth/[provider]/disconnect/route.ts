import { getHostedConfig, type HostedProvider } from "@/packages/hosted/src/config";
import { clearProviderToken, readProviderToken } from "@/packages/hosted/src/session";
import { hostedError, hostedJson, requireSameOrigin } from "@/packages/hosted/src/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function providerValue(value: string): HostedProvider {
  if (value !== "spotify" && value !== "youtube") throw new Error("HOSTED_PROVIDER_INVALID");
  return value;
}

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  try {
    const provider = providerValue((await context.params).provider);
    const config = getHostedConfig(request.url);
    requireSameOrigin(request, config);
    const token = await readProviderToken(provider, config);
    if (provider === "youtube" && token) {
      const revokeToken = token.refreshToken || token.accessToken;
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: revokeToken }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
    await clearProviderToken(provider);
    return hostedJson({ disconnected: true, provider });
  } catch (error) {
    return hostedError(error);
  }
}
