import { getHostedConfig, type HostedProvider } from "@/packages/hosted/src/config";
import { readProviderToken } from "@/packages/hosted/src/session";
import { getHostedClient, hostedError, hostedJson } from "@/packages/hosted/src/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function connection(provider: HostedProvider, requestUrl: string) {
  const config = getHostedConfig(requestUrl);
  if (!await readProviderToken(provider, config)) return { connected: false as const };
  try {
    const client = await getHostedClient(provider, requestUrl);
    return { connected: true as const, account: await client.getAccount() };
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) : "CONNECTION_FAILED";
    return { connected: false as const, reason };
  }
}

export async function GET(request: Request) {
  try {
    getHostedConfig(request.url);
    const spotify = await connection("spotify", request.url);
    const youtube = await connection("youtube", request.url);
    return hostedJson({
      hosted: true,
      connections: { spotify, youtube },
      soundcloud: { enabled: false },
      limits: { tracksPerTransfer: 100 },
    });
  } catch (error) {
    return hostedError(error);
  }
}
