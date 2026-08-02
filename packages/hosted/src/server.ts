import type { HostedConfig, HostedProvider } from "./config";
import { getHostedConfig } from "./config";
import { refreshHostedToken } from "./oauth";
import { clearProviderToken, readProviderToken, writeProviderToken } from "./session";
import { HostedSpotifyClient } from "./spotify";
import type { DestinationClient, HostedCandidate, HostedSnapshot, HostedTrack } from "./types";
import { HostedYoutubeClient } from "./youtube";

export type PreparedItem = {
  source: HostedTrack;
  query: string;
  candidates: HostedCandidate[];
};

export function hostedJson(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function safeError(error: unknown): { code: string; status: number } {
  const message = error instanceof Error ? error.message : "HOSTED_UNKNOWN_ERROR";
  if (/REAUTH_REQUIRED|HTTP_401/u.test(message)) return { code: message, status: 401 };
  if (/NOT_CONNECTED/u.test(message)) return { code: message, status: 401 };
  if (/REQUIRED|INVALID|MISMATCH|TOO_LARGE|NO_SELECTIONS|SOURCE_CHANGED/u.test(message)) return { code: message, status: 400 };
  if (/HTTP_403/u.test(message)) return { code: message, status: 403 };
  if (/HTTP_404|NOT_FOUND/u.test(message)) return { code: message, status: 404 };
  if (/HTTP_429/u.test(message)) return { code: message, status: 429 };
  if (/HOSTED_CONFIG_MISSING|HOSTED_MODE_DISABLED/u.test(message)) return { code: message, status: 503 };
  return { code: message.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160) || "HOSTED_REQUEST_FAILED", status: 500 };
}

export function hostedError(error: unknown): Response {
  const { code, status } = safeError(error);
  return hostedJson({ error: code }, status);
}

export function requireSameOrigin(request: Request, config: HostedConfig): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== config.origin) throw new Error("HOSTED_ORIGIN_MISMATCH");
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw new Error("HOSTED_JSON_REQUIRED");
}

export async function getHostedClient(provider: HostedProvider, requestUrl: string): Promise<DestinationClient> {
  const config = getHostedConfig(requestUrl);
  let token = await readProviderToken(provider, config);
  if (!token) throw new Error(`${provider.toUpperCase()}_NOT_CONNECTED`);
  if (token.expiresAtMs <= Date.now() + 90_000) {
    try {
      token = await refreshHostedToken(config, provider, token);
      await writeProviderToken(provider, token, config);
    } catch (error) {
      await clearProviderToken(provider);
      throw error;
    }
  }
  return provider === "spotify"
    ? new HostedSpotifyClient(token.accessToken)
    : new HostedYoutubeClient(token.accessToken);
}

export function otherProvider(provider: HostedProvider): HostedProvider {
  return provider === "spotify" ? "youtube" : "spotify";
}

function compact(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function cleanYoutubeSource(track: HostedTrack): { title: string; artist: string } {
  let title = track.title
    .replace(/\s*[\[(](?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|visuali[sz]er|clip)[^\])]*[\])]/giu, " ")
    .replace(/\s*[\[(](?:hd|hq|4k)[^\])]*[\])]/giu, " ");
  let artist = track.artist.replace(/\s*-\s*Topic$/iu, "");
  const dash = /^\s*(.{1,100}?)\s+[-–—]\s+(.{1,180})$/u.exec(title);
  if (dash?.[1] && dash[2]) {
    artist = dash[1];
    title = dash[2];
  }
  return { title: compact(title), artist: compact(artist) };
}

export function buildHostedSearchQuery(sourceProvider: HostedProvider, track: HostedTrack): string {
  if (sourceProvider === "youtube") {
    const clean = cleanYoutubeSource(track);
    const escapedTitle = clean.title.replace(/["\\]/gu, " ");
    const escapedArtist = clean.artist.replace(/["\\]/gu, " ");
    return escapedArtist
      ? `track:"${escapedTitle}" artist:"${escapedArtist}"`
      : `track:"${escapedTitle}"`;
  }
  return compact(`${track.artist} - ${track.title} official audio`);
}

export async function prepareHostedTransfer(input: {
  requestUrl: string;
  sourceProvider: HostedProvider;
  sourcePlaylistId: string;
}): Promise<{ source: HostedSnapshot; targetProvider: HostedProvider; items: PreparedItem[] }> {
  const targetProvider = otherProvider(input.sourceProvider);
  const [sourceClient, targetClient] = await Promise.all([
    getHostedClient(input.sourceProvider, input.requestUrl),
    getHostedClient(targetProvider, input.requestUrl),
  ]);
  const source = await sourceClient.snapshot(input.sourcePlaylistId);
  const available = source.tracks.filter((track) => track.available);
  if (available.length > 100) throw new Error("HOSTED_PLAYLIST_TOO_LARGE_100");
  const items: PreparedItem[] = [];
  for (const track of available) {
    const query = buildHostedSearchQuery(input.sourceProvider, track);
    const candidates = await targetClient.search(query, 5);
    items.push({ source: track, query, candidates });
  }
  return { source, targetProvider, items };
}

function orderedSuffixVerified(before: string[], after: string[], expected: string[]): boolean {
  if (after.length < before.length + expected.length) return false;
  if (!before.every((id, index) => after[index] === id)) return false;
  return expected.every((id, index) => after[before.length + index] === id);
}

export async function executeHostedTransfer(input: {
  requestUrl: string;
  sourceProvider: HostedProvider;
  sourcePlaylistId: string;
  sourceVersion: string;
  destinationPlaylistId?: string;
  destinationTitle?: string;
  public: boolean;
  selections: Array<{ sourceId: string; targetId: string }>;
}): Promise<{
  destination: { id: string; url: string; title: string; created: boolean };
  sourceCount: number;
  selectedCount: number;
  addedCount: number;
  failures: Array<{ id: string; error: string }>;
  verified: boolean;
}> {
  if (!input.selections.length) throw new Error("HOSTED_NO_SELECTIONS");
  if (input.selections.length > 100) throw new Error("HOSTED_SELECTIONS_TOO_LARGE_100");
  const targetProvider = otherProvider(input.sourceProvider);
  const [sourceClient, targetClient] = await Promise.all([
    getHostedClient(input.sourceProvider, input.requestUrl),
    getHostedClient(targetProvider, input.requestUrl),
  ]);
  const source = await sourceClient.snapshot(input.sourcePlaylistId);
  if (source.version !== input.sourceVersion) throw new Error("HOSTED_SOURCE_CHANGED_PREPARE_AGAIN");
  const sourceIds = new Set(source.tracks.filter((track) => track.available).map((track) => track.id));
  const seenSources = new Set<string>();
  for (const selection of input.selections) {
    if (!sourceIds.has(selection.sourceId) || seenSources.has(selection.sourceId)) throw new Error("HOSTED_SELECTION_SOURCE_INVALID");
    seenSources.add(selection.sourceId);
  }
  const selectedTargetIds = input.selections.map((selection) => selection.targetId);
  const validTargets = await targetClient.validateTargetIds(selectedTargetIds);
  if (selectedTargetIds.some((id) => !validTargets.has(id))) throw new Error("HOSTED_SELECTION_TARGET_INVALID");

  let destinationId = input.destinationPlaylistId?.trim();
  let destinationUrl = "";
  let destinationTitle = input.destinationTitle?.trim() || `Codex ${new Date().toISOString().slice(0, 10)}`;
  let created = false;
  if (destinationId) {
    const existing = await targetClient.snapshot(destinationId);
    if (!existing.playlist.writable) throw new Error("HOSTED_DESTINATION_NOT_WRITABLE");
    destinationUrl = existing.playlist.url;
    destinationTitle = existing.playlist.title;
  } else {
    if (destinationTitle.length < 1 || destinationTitle.length > 100) throw new Error("HOSTED_DESTINATION_TITLE_INVALID");
    const destination = await targetClient.createPlaylist({
      title: destinationTitle,
      description: `Playlist-Transfer: ${source.playlist.title} (${input.sourceProvider} → ${targetProvider})`,
      public: input.public,
    });
    destinationId = destination.id;
    destinationUrl = destination.url;
    created = true;
  }

  const before = await targetClient.snapshot(destinationId);
  const write = await targetClient.append(destinationId, selectedTargetIds);
  const after = await targetClient.snapshot(destinationId);
  return {
    destination: { id: destinationId, url: destinationUrl || after.playlist.url, title: destinationTitle, created },
    sourceCount: source.tracks.length,
    selectedCount: selectedTargetIds.length,
    addedCount: write.addedIds.length,
    failures: write.failures,
    verified: orderedSuffixVerified(
      before.tracks.map((track) => track.id),
      after.tracks.map((track) => track.id),
      write.addedIds,
    ),
  };
}
