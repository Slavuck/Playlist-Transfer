import type { HostedProvider } from "@/packages/hosted/src/config";
import { getHostedConfig } from "@/packages/hosted/src/config";
import { executeHostedTransfer, hostedError, hostedJson, requireSameOrigin } from "@/packages/hosted/src/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function providerValue(value: unknown): HostedProvider {
  if (value !== "spotify" && value !== "youtube") throw new Error("HOSTED_PROVIDER_INVALID");
  return value;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function POST(request: Request) {
  try {
    const config = getHostedConfig(request.url);
    requireSameOrigin(request, config);
    const body = await request.json() as Record<string, unknown>;
    const selections = Array.isArray(body.selections)
      ? body.selections.flatMap((value) => {
          const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
          const sourceId = text(item.sourceId);
          const targetId = text(item.targetId);
          return sourceId && targetId ? [{ sourceId, targetId }] : [];
        })
      : [];
    const sourcePlaylistId = text(body.sourcePlaylistId);
    const sourceVersion = text(body.sourceVersion);
    if (!sourcePlaylistId || !sourceVersion) throw new Error("HOSTED_SOURCE_REQUIRED");
    const result = await executeHostedTransfer({
      requestUrl: request.url,
      sourceProvider: providerValue(body.sourceProvider),
      sourcePlaylistId,
      sourceVersion,
      destinationPlaylistId: text(body.destinationPlaylistId),
      destinationTitle: text(body.destinationTitle),
      public: body.public === true,
      selections,
    });
    return hostedJson(result);
  } catch (error) {
    return hostedError(error);
  }
}
