import type { HostedProvider } from "@/packages/hosted/src/config";
import { getHostedConfig } from "@/packages/hosted/src/config";
import { hostedError, hostedJson, prepareHostedTransfer, requireSameOrigin } from "@/packages/hosted/src/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function providerValue(value: unknown): HostedProvider {
  if (value !== "spotify" && value !== "youtube") throw new Error("HOSTED_PROVIDER_INVALID");
  return value;
}

export async function POST(request: Request) {
  try {
    const config = getHostedConfig(request.url);
    requireSameOrigin(request, config);
    const body = await request.json() as Record<string, unknown>;
    const sourcePlaylistId = typeof body.sourcePlaylistId === "string" ? body.sourcePlaylistId : "";
    if (!sourcePlaylistId) throw new Error("HOSTED_SOURCE_PLAYLIST_REQUIRED");
    const prepared = await prepareHostedTransfer({
      requestUrl: request.url,
      sourceProvider: providerValue(body.sourceProvider),
      sourcePlaylistId,
    });
    return hostedJson(prepared);
  } catch (error) {
    return hostedError(error);
  }
}
