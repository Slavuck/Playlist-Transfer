import type { HostedProvider } from "@/packages/hosted/src/config";
import { getHostedClient, hostedError, hostedJson } from "@/packages/hosted/src/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function providerValue(value: string | null): HostedProvider {
  if (value !== "spotify" && value !== "youtube") throw new Error("HOSTED_PROVIDER_INVALID");
  return value;
}

export async function GET(request: Request) {
  try {
    const provider = providerValue(new URL(request.url).searchParams.get("provider"));
    const client = await getHostedClient(provider, request.url);
    return hostedJson({ provider, playlists: await client.listPlaylists() });
  } catch (error) {
    return hostedError(error);
  }
}
