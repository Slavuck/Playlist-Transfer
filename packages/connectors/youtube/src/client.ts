import { randomUUID } from "node:crypto";
import type { LocalDatabase } from "../../../storage-local/src/database";
import { youtubeApiCapabilities } from "../../../connectors-core/src/policy";
import type { ProviderEntityRef, ValidationResult } from "../../../connectors-core/src/types";
import { assertYoutubeVideoRef } from "../../../connectors-core/src/url-policy";
import { refreshYoutubeToken, type YoutubeTokenSet } from "./oauth";

type FetchLike = typeof fetch;
type MutationAwareError = Error & { providerMutationMayHaveStarted?: boolean };

function markBeforeMutation(error: unknown): never {
  if (error instanceof Error) {
    (error as MutationAwareError).providerMutationMayHaveStarted = false;
    throw error;
  }
  const wrapped = new Error("YOUTUBE_API_PRECONDITION_FAILED") as MutationAwareError;
  wrapped.providerMutationMayHaveStarted = false;
  throw wrapped;
}

export type YoutubeCredentials = YoutubeTokenSet & { clientId: string; channelId?: string };

export type YoutubePlaylist = {
  id: string;
  title: string;
  description: string;
  itemCount: number;
  privacyStatus: string;
  channelId: string;
  channelTitle: string;
  etag?: string;
  ownership: "API_OWNED";
};

export type YoutubeTrack = {
  videoId: string;
  title: string;
  channelTitle: string;
  durationMs?: number;
  embeddable?: boolean;
  position: number;
  availability: "AVAILABLE" | "UNAVAILABLE";
  url: string;
};

export type YoutubeCandidate = {
  provider: "youtube";
  providerEntityId: string;
  videoId: string;
  providerUriOrUrl: string;
  titleRaw: string;
  artistRaw: string;
  durationMs?: number;
  embeddable: boolean;
  availability: "AVAILABLE" | "UNAVAILABLE";
  searchRank: number;
  validationStatus: "PROVIDER_VALIDATED";
};

export type QuotaUse = (bucket: "search" | "general", amount: number, limit: number) => boolean;

const API_ROOT = "https://www.googleapis.com/youtube/v3";

function parseIsoDuration(value?: string): number | undefined {
  if (!value) return undefined;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match) return undefined;
  const seconds = Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3_600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1_000) : undefined;
}

export function youtubeQuotaPeriodKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function createYoutubeQuotaUse(database: LocalDatabase): QuotaUse {
  return (bucket, amount, limit) => database.useQuota("youtube", bucket, youtubeQuotaPeriodKey(), amount, limit);
}

export class YoutubeApiClient {
  readonly provider = "youtube" as const;
  readonly strategy = "api" as const;
  readonly capabilities = youtubeApiCapabilities;

  constructor(
    private credentials: YoutubeCredentials,
    private readonly options: {
      fetchImpl?: FetchLike;
      quotaUse?: QuotaUse;
      onTokenRefresh?: (credentials: YoutubeCredentials) => Promise<void> | void;
      onReauthRequired?: () => Promise<void> | void;
    } = {},
  ) {}

  private async ensureToken() {
    if (this.credentials.expiresAtMs > Date.now() + 60_000) return;
    if (!this.credentials.refreshToken) {
      await this.options.onReauthRequired?.();
      throw new Error("YOUTUBE_REAUTH_REQUIRED");
    }
    let refreshed: YoutubeTokenSet;
    try {
      refreshed = await refreshYoutubeToken({
        clientId: this.credentials.clientId,
        refreshToken: this.credentials.refreshToken,
        previousScopes: this.credentials.scopes,
        fetchImpl: this.options.fetchImpl,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "YOUTUBE_REAUTH_REQUIRED") {
        await this.options.onReauthRequired?.();
      }
      throw error;
    }
    this.credentials = { ...this.credentials, ...refreshed };
    await this.options.onTokenRefresh?.(this.credentials);
  }

  private consume(bucket: "search" | "general", amount: number) {
    const limit = bucket === "search" ? 100 : 10_000;
    if (this.options.quotaUse && !this.options.quotaUse(bucket, amount, limit)) {
      throw new Error(`YOUTUBE_${bucket.toUpperCase()}_QUOTA_WAIT`);
    }
  }

  private async request<T>(path: string, query: Record<string, string | number | undefined>, init?: RequestInit, cost = 1): Promise<T> {
    try {
      await this.ensureToken();
      if (cost > 0) this.consume("general", cost);
    } catch (error) {
      markBeforeMutation(error);
    }
    const url = new URL(`${API_ROOT}/${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.credentials.accessToken}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    const text = await response.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const reason = JSON.stringify(body);
      if (response.status === 401) {
        await this.options.onReauthRequired?.();
        throw new Error("YOUTUBE_REAUTH_REQUIRED");
      }
      if (response.status === 429) throw new Error("YOUTUBE_QUOTA_WAIT");
      if (response.status === 403 && /quotaExceeded|dailyLimitExceeded/.test(reason)) throw new Error("YOUTUBE_QUOTA_WAIT");
      if (response.status === 403) throw new Error("YOUTUBE_WRITE_FORBIDDEN");
      if (response.status === 404) throw new Error("YOUTUBE_NOT_FOUND");
      throw new Error(`YOUTUBE_API_${response.status}`);
    }
    return body as T;
  }

  async getCurrentAccount(): Promise<{ channelId: string; title: string }> {
    const payload = await this.request<{ items?: Array<{ id: string; snippet?: { title?: string } }> }>("channels", {
      part: "id,snippet",
      mine: "true",
      maxResults: 50,
    });
    const channel = payload.items?.find((item) => !this.credentials.channelId || item.id === this.credentials.channelId) ?? payload.items?.[0];
    if (!channel) throw new Error("YOUTUBE_CHANNEL_REQUIRED");
    return { channelId: channel.id, title: channel.snippet?.title ?? channel.id };
  }

  async listEligiblePlaylists(): Promise<YoutubePlaylist[]> {
    const account = await this.getCurrentAccount();
    const results: YoutubePlaylist[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.request<{
        nextPageToken?: string;
        items?: Array<{
          id: string;
          etag?: string;
          snippet?: { title?: string; description?: string; channelId?: string; channelTitle?: string };
          status?: { privacyStatus?: string };
          contentDetails?: { itemCount?: number };
        }>;
      }>("playlists", {
        part: "snippet,status,contentDetails",
        mine: "true",
        maxResults: 50,
        pageToken,
      });
      for (const item of page.items ?? []) {
        if (item.snippet?.channelId !== account.channelId) continue;
        results.push({
          id: item.id,
          title: item.snippet.title ?? "Untitled",
          description: item.snippet.description ?? "",
          itemCount: item.contentDetails?.itemCount ?? 0,
          privacyStatus: item.status?.privacyStatus ?? "private",
          channelId: item.snippet.channelId,
          channelTitle: item.snippet.channelTitle ?? account.title,
          etag: item.etag,
          ownership: "API_OWNED",
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return results;
  }

  async getPlaylistSnapshot(playlistId: string): Promise<{ playlist: YoutubePlaylist; tracks: YoutubeTrack[]; sourceVersion: string }> {
    const playlist = (await this.listEligiblePlaylists()).find((item) => item.id === playlistId);
    if (!playlist) throw new Error("YOUTUBE_PLAYLIST_NOT_OWNED");
    const raw: Array<{ videoId: string; title: string; channelTitle: string; position: number; unavailable: boolean }> = [];
    let pageToken: string | undefined;
    do {
      const page = await this.request<{
        nextPageToken?: string;
        items?: Array<{
          snippet?: { title?: string; channelTitle?: string; position?: number; resourceId?: { videoId?: string } };
          contentDetails?: { videoId?: string };
          status?: { privacyStatus?: string };
        }>;
      }>("playlistItems", {
        part: "snippet,contentDetails,status",
        playlistId,
        maxResults: 50,
        pageToken,
      });
      for (const item of page.items ?? []) {
        const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
        if (!videoId) continue;
        const title = item.snippet?.title ?? "Unavailable video";
        raw.push({
          videoId,
          title,
          channelTitle: item.snippet?.channelTitle ?? "",
          position: item.snippet?.position ?? raw.length,
          unavailable: title === "Deleted video" || title === "Private video",
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    const details = await this.getVideoDetails(raw.map((item) => item.videoId));
    const tracks = raw.map<YoutubeTrack>((item) => {
      const detail = details.get(item.videoId);
      return {
        videoId: item.videoId,
        title: detail?.title ?? item.title,
        channelTitle: detail?.channelTitle ?? item.channelTitle,
        durationMs: detail?.durationMs,
        embeddable: detail?.embeddable === true,
        position: item.position,
        availability: item.unavailable || !detail ? "UNAVAILABLE" : "AVAILABLE",
        url: `https://www.youtube.com/watch?v=${item.videoId}`,
      };
    });
    return { playlist, tracks, sourceVersion: playlist.etag ?? `${playlist.id}:${tracks.length}` };
  }

  async getVideoDetails(videoIds: string[]) {
    const result = new Map<string, { title: string; channelTitle: string; durationMs?: number; embeddable?: boolean }>();
    for (let index = 0; index < videoIds.length; index += 50) {
      const ids = [...new Set(videoIds.slice(index, index + 50))];
      if (!ids.length) continue;
      const payload = await this.request<{
        items?: Array<{
          id: string;
          snippet?: { title?: string; channelTitle?: string };
          contentDetails?: { duration?: string };
          status?: { embeddable?: boolean; privacyStatus?: string; uploadStatus?: string };
        }>;
      }>("videos", { part: "snippet,contentDetails,status", id: ids.join(",") });
      for (const item of payload.items ?? []) {
        result.set(item.id, {
          title: item.snippet?.title ?? item.id,
          channelTitle: item.snippet?.channelTitle ?? "",
          durationMs: parseIsoDuration(item.contentDetails?.duration),
          embeddable: item.status?.embeddable,
        });
      }
    }
    return result;
  }

  async searchCandidates(query: string, maxResults = 10): Promise<YoutubeCandidate[]> {
    await this.ensureToken();
    this.consume("search", 1);
    const search = await this.request<{
      items?: Array<{ id?: { videoId?: string } }>;
    }>("search", {
      part: "snippet",
      type: "video",
      q: query,
      maxResults: Math.min(25, Math.max(1, maxResults)),
      videoEmbeddable: "true",
    }, undefined, 0);
    const ids = (search.items ?? []).map((item) => item.id?.videoId).filter((id): id is string => Boolean(id));
    const details = await this.getVideoDetails(ids);
    return ids.flatMap((videoId, index) => {
      const detail = details.get(videoId);
      if (!detail) return [];
      return [{
        provider: "youtube" as const,
        providerEntityId: videoId,
        videoId,
        providerUriOrUrl: `https://www.youtube.com/watch?v=${videoId}`,
        titleRaw: detail.title,
        artistRaw: detail.channelTitle,
        durationMs: detail.durationMs,
        embeddable: detail.embeddable === true,
        availability: "AVAILABLE" as const,
        searchRank: index,
        validationStatus: "PROVIDER_VALIDATED" as const,
      }];
    });
  }

  async validateTargetEntity(ref: ProviderEntityRef): Promise<ValidationResult> {
    assertYoutubeVideoRef(ref);
    const details = await this.getVideoDetails([ref.videoId]);
    const detail = details.get(ref.videoId);
    if (!detail) throw new Error("YOUTUBE_TARGET_NOT_FOUND");
    const checkedAt = Date.now();
    return {
      ref: {
        ...ref,
        providerEntityId: ref.videoId,
        titleRaw: detail.title,
        artistRaw: detail.channelTitle,
        durationMs: detail.durationMs,
        embeddable: detail.embeddable === true,
        validationStatus: "PROVIDER_VALIDATED",
        fetchedAt: checkedAt,
      },
      evidence: { method: "OFFICIAL_API", checkedAt, providerReadBack: true, semanticEqualityProven: false },
      limitations: ["YOUTUBE_MUSIC_VISIBILITY_NOT_GUARANTEED", "SEMANTIC_EQUALITY_NOT_PROVEN"],
    };
  }

  async createPlaylist(input: { title: string; description?: string; privacyStatus: "private" | "public" | "unlisted" }): Promise<{ id: string; url: string }> {
    const response = await this.request<{ id?: string }>(
      "playlists",
      { part: "snippet,status" },
      {
        method: "POST",
        body: JSON.stringify({ snippet: { title: input.title, description: input.description ?? "" }, status: { privacyStatus: input.privacyStatus } }),
      },
      50,
    );
    if (!response.id) throw new Error("YOUTUBE_CREATE_UNVERIFIED");
    return { id: response.id, url: `https://www.youtube.com/playlist?list=${response.id}` };
  }

  async appendItem(playlistId: string, videoId: string): Promise<{ playlistItemId: string; videoId: string }> {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("YOUTUBE_VIDEO_ID_REQUIRED");
    const response = await this.request<{ id?: string; snippet?: { resourceId?: { videoId?: string } } }>(
      "playlistItems",
      { part: "snippet" },
      {
        method: "POST",
        body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } }),
      },
      50,
    );
    if (!response.id || response.snippet?.resourceId?.videoId !== videoId) throw new Error("YOUTUBE_WRITE_UNVERIFIED");
    return { playlistItemId: response.id, videoId };
  }

  async verifyPlaylist(playlistId: string, expectedVideoIds: string[]): Promise<{ verified: boolean; actualVideoIds: string[]; checkedAt: number }> {
    const actual: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.request<{
        nextPageToken?: string;
        items?: Array<{ contentDetails?: { videoId?: string } }>;
      }>("playlistItems", { part: "contentDetails", playlistId, maxResults: 50, pageToken });
      actual.push(...(page.items ?? []).map((item) => item.contentDetails?.videoId).filter((id): id is string => Boolean(id)));
      pageToken = page.nextPageToken;
    } while (pageToken);
    let cursor = 0;
    const ordered = expectedVideoIds.every((expected) => {
      const found = actual.indexOf(expected, cursor);
      if (found < 0) return false;
      cursor = found + 1;
      return true;
    });
    return { verified: ordered, actualVideoIds: actual, checkedAt: Date.now() };
  }

  createWriteReceipt(input: { transferId: string; transferItemId: string; playlistId: string; videoId: string; idempotencyKey: string; verified: boolean }) {
    return {
      id: randomUUID(),
      transferId: input.transferId,
      transferItemId: input.transferItemId,
      destinationPlaylistId: input.playlistId,
      targetEntityId: input.videoId,
      idempotencyKey: input.idempotencyKey,
      executionStatus: "WRITTEN",
      verificationStatus: input.verified ? "VERIFIED_PROVIDER" : "WRITE_UNVERIFIED",
      evidence: input.verified ? { method: "YOUTUBE_PLAYLIST_ITEMS_READ_AFTER_WRITE", checkedAt: Date.now() } : {},
      manual: false,
      risky: false,
    };
  }
}

export { parseIsoDuration };
