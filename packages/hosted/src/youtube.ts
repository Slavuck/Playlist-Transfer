import type {
  DestinationClient,
  HostedAccount,
  HostedCandidate,
  HostedPlaylist,
  HostedSnapshot,
  HostedTrack,
} from "./types";

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return value && typeof value === "object" ? value as Json : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function youtubePlaylistId(value: string): string {
  if (!/^[A-Za-z0-9_-]{10,80}$/u.test(value)) throw new Error("YOUTUBE_PLAYLIST_ID_REQUIRED");
  return value;
}

function youtubeVideoId(value: string): string {
  if (!/^[A-Za-z0-9_-]{11}$/u.test(value)) throw new Error("YOUTUBE_VIDEO_ID_REQUIRED");
  return value;
}

function youtubeError(status: number, payload: unknown): Error {
  const root = object(payload);
  const nested = object(root.error);
  const detail = object(array(nested.errors)[0]);
  const code = text(detail.reason) || text(nested.status) || "REQUEST_FAILED";
  return new Error(`YOUTUBE_HTTP_${status}_${code.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}`);
}

export function parseYoutubeDuration(value: string): number | undefined {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/u.exec(value);
  if (!match) return undefined;
  return Math.round((Number(match[1] ?? 0) * 3_600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1_000);
}

type VideoDetail = { id: string; title: string; artist: string; durationMs?: number; available: boolean };

export class HostedYoutubeClient implements DestinationClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T extends Json>(resource: string, params: Record<string, string | number | undefined>, init?: RequestInit): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, String(value));
    const response = await this.fetchImpl(`https://www.googleapis.com/youtube/v3/${resource}?${query}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      redirect: "error",
      signal: init?.signal ?? AbortSignal.timeout(20_000),
    });
    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) throw youtubeError(response.status, payload);
    return payload as T;
  }

  async getAccount(): Promise<HostedAccount> {
    const payload = await this.request<Json>("channels", { part: "snippet", mine: "true", maxResults: 1 });
    const channel = object(array(payload.items)[0]);
    const id = text(channel.id);
    if (!id) throw new Error("YOUTUBE_CHANNEL_NOT_FOUND");
    return { id, label: text(object(channel.snippet).title) || id, url: `https://www.youtube.com/channel/${id}` };
  }

  async listPlaylists(): Promise<HostedPlaylist[]> {
    const account = await this.getAccount();
    const output: HostedPlaylist[] = [];
    let pageToken: string | undefined;
    do {
      const payload = await this.request<Json>("playlists", {
        part: "snippet,contentDetails,status",
        mine: "true",
        maxResults: 50,
        pageToken,
      });
      for (const raw of array(payload.items)) {
        const item = object(raw);
        const id = text(item.id);
        if (!/^[A-Za-z0-9_-]{10,80}$/u.test(id)) continue;
        const snippet = object(item.snippet);
        output.push({
          id,
          provider: "youtube",
          title: text(snippet.title) || id,
          description: text(snippet.description),
          itemCount: number(object(item.contentDetails).itemCount) ?? 0,
          ownerLabel: text(snippet.channelTitle) || account.label,
          url: `https://www.youtube.com/playlist?list=${id}`,
          writable: true,
        });
      }
      pageToken = text(payload.nextPageToken) || undefined;
    } while (pageToken);
    return output;
  }

  private async videoDetails(ids: string[]): Promise<Map<string, VideoDetail>> {
    const output = new Map<string, VideoDetail>();
    const unique = [...new Set(ids)].filter((id) => /^[A-Za-z0-9_-]{11}$/u.test(id));
    for (let index = 0; index < unique.length; index += 50) {
      const payload = await this.request<Json>("videos", {
        part: "snippet,contentDetails,status",
        id: unique.slice(index, index + 50).join(","),
        maxResults: 50,
      });
      for (const raw of array(payload.items)) {
        const item = object(raw);
        const id = text(item.id);
        const snippet = object(item.snippet);
        const status = object(item.status);
        if (!id) continue;
        output.set(id, {
          id,
          title: text(snippet.title) || id,
          artist: text(snippet.channelTitle),
          durationMs: parseYoutubeDuration(text(object(item.contentDetails).duration)),
          available: status.uploadStatus !== "deleted" && status.privacyStatus !== "private",
        });
      }
    }
    return output;
  }

  async snapshot(playlistId: string): Promise<HostedSnapshot> {
    youtubePlaylistId(playlistId);
    const playlistPayload = await this.request<Json>("playlists", { part: "snippet,contentDetails,status", id: playlistId, maxResults: 1 });
    const item = object(array(playlistPayload.items)[0]);
    if (!text(item.id)) throw new Error("YOUTUBE_PLAYLIST_NOT_FOUND");
    const snippet = object(item.snippet);
    const raw: Array<{ id: string; title: string; artist: string; position: number }> = [];
    let pageToken: string | undefined;
    do {
      const payload = await this.request<Json>("playlistItems", { part: "snippet,contentDetails", playlistId, maxResults: 50, pageToken });
      for (const rowValue of array(payload.items)) {
        const row = object(rowValue);
        const rowSnippet = object(row.snippet);
        const videoId = text(object(row.contentDetails).videoId) || text(object(rowSnippet.resourceId).videoId);
        if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) continue;
        raw.push({
          id: videoId,
          title: text(rowSnippet.title) || videoId,
          artist: text(rowSnippet.videoOwnerChannelTitle) || text(rowSnippet.channelTitle),
          position: number(rowSnippet.position) ?? raw.length,
        });
      }
      pageToken = text(payload.nextPageToken) || undefined;
    } while (pageToken);
    const details = await this.videoDetails(raw.map((track) => track.id));
    const tracks = raw.map<HostedTrack>((track) => {
      const detail = details.get(track.id);
      return {
        id: track.id,
        title: detail?.title ?? track.title,
        artist: detail?.artist ?? track.artist,
        durationMs: detail?.durationMs,
        url: `https://www.youtube.com/watch?v=${track.id}`,
        position: track.position,
        available: detail?.available === true,
      };
    });
    return {
      playlist: {
        id: playlistId,
        provider: "youtube",
        title: text(snippet.title) || playlistId,
        description: text(snippet.description),
        itemCount: tracks.length,
        ownerLabel: text(snippet.channelTitle),
        url: `https://www.youtube.com/playlist?list=${playlistId}`,
        writable: true,
      },
      tracks,
      version: text(item.etag) || `${playlistId}:${tracks.length}`,
    };
  }

  async search(query: string, limit = 5): Promise<HostedCandidate[]> {
    const payload = await this.request<Json>("search", {
      part: "snippet",
      type: "video",
      q: query.slice(0, 250),
      maxResults: Math.max(1, Math.min(10, limit)),
      videoEmbeddable: "true",
    });
    const ids = array(payload.items).map((item) => text(object(object(item).id).videoId)).filter(Boolean);
    const details = await this.videoDetails(ids);
    return ids.flatMap((id, rank) => {
      const detail = details.get(id);
      if (!detail?.available) return [];
      return [{
        id,
        provider: "youtube" as const,
        title: detail.title,
        artist: detail.artist,
        durationMs: detail.durationMs,
        url: `https://www.youtube.com/watch?v=${id}`,
        rank,
      }];
    });
  }

  async validateTargetIds(ids: string[]): Promise<Set<string>> {
    const details = await this.videoDetails(ids);
    return new Set([...details].filter(([, detail]) => detail.available).map(([id]) => id));
  }

  async createPlaylist(input: { title: string; description: string; public: boolean }): Promise<{ id: string; url: string }> {
    const payload = await this.request<Json>("playlists", { part: "snippet,status" }, {
      method: "POST",
      body: JSON.stringify({
        snippet: { title: input.title.slice(0, 150), description: input.description.slice(0, 1_000) },
        status: { privacyStatus: input.public ? "public" : "private" },
      }),
    });
    const id = youtubePlaylistId(text(payload.id));
    return { id, url: `https://www.youtube.com/playlist?list=${id}` };
  }

  async append(playlistId: string, targetIds: string[]): Promise<{ addedIds: string[]; failures: Array<{ id: string; error: string }> }> {
    youtubePlaylistId(playlistId);
    const addedIds: string[] = [];
    const failures: Array<{ id: string; error: string }> = [];
    for (const idValue of targetIds) {
      try {
        const id = youtubeVideoId(idValue);
        const payload = await this.request<Json>("playlistItems", { part: "snippet" }, {
          method: "POST",
          body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: "youtube#video", videoId: id } } }),
        });
        if (!text(payload.id)) throw new Error("YOUTUBE_APPEND_UNVERIFIED");
        addedIds.push(id);
      } catch (error) {
        failures.push({ id: idValue, error: error instanceof Error ? error.message : "YOUTUBE_APPEND_FAILED" });
      }
    }
    return { addedIds, failures };
  }
}
