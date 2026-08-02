import type {
  DestinationClient,
  HostedAccount,
  HostedCandidate,
  HostedPlaylist,
  HostedSnapshot,
  HostedTrack,
} from "./types";

type Json = Record<string, unknown>;

function spotifyId(value: string, code: string): string {
  if (!/^[A-Za-z0-9]{22}$/u.test(value)) throw new Error(code);
  return value;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function object(value: unknown): Json {
  return value && typeof value === "object" ? value as Json : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function spotifyError(status: number, payload: unknown): Error {
  const root = object(payload);
  const nested = object(root.error);
  const code = text(nested.reason) || text(root.error) || text(nested.status) || "REQUEST_FAILED";
  return new Error(`SPOTIFY_HTTP_${status}_${code.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}`);
}

function artists(track: Json): string {
  return array(track.artists).map((artist) => text(object(artist).name)).filter(Boolean).join(", ");
}

function toTrack(value: unknown, position: number): HostedTrack | null {
  const track = object(value);
  const id = text(track.id);
  const title = text(track.name);
  if (!/^[A-Za-z0-9]{22}$/u.test(id) || !title) return null;
  return {
    id,
    title,
    artist: artists(track),
    durationMs: number(track.duration_ms),
    isrc: text(object(track.external_ids).isrc) || undefined,
    url: text(object(track.external_urls).spotify) || `https://open.spotify.com/track/${id}`,
    position,
    available: track.is_playable !== false && !track.restrictions,
  };
}

function toCandidate(value: unknown, rank: number): HostedCandidate | null {
  const track = toTrack(value, rank);
  return track ? {
    id: track.id,
    provider: "spotify",
    title: track.title,
    artist: track.artist,
    durationMs: track.durationMs,
    url: track.url,
    rank,
  } : null;
}

export class HostedSpotifyClient implements DestinationClient {
  private account?: HostedAccount;

  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T extends Json>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`https://api.spotify.com/v1/${path.replace(/^\//, "")}`, {
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
    if (!response.ok) throw spotifyError(response.status, payload);
    return payload as T;
  }

  async getAccount(): Promise<HostedAccount> {
    if (this.account) return this.account;
    const me = await this.request<Json>("me");
    const id = text(me.id);
    if (!id) throw new Error("SPOTIFY_ACCOUNT_INVALID");
    this.account = {
      id,
      label: text(me.display_name) || id,
      url: text(object(me.external_urls).spotify) || `https://open.spotify.com/user/${id}`,
    };
    return this.account;
  }

  async listPlaylists(): Promise<HostedPlaylist[]> {
    const account = await this.getAccount();
    const output: HostedPlaylist[] = [];
    let path: string | undefined = "me/playlists?limit=50";
    for (let page = 0; path && page < 20; page += 1) {
      const payload: Json = await this.request<Json>(path);
      for (const raw of array(payload.items)) {
        const item = object(raw);
        const id = text(item.id);
        if (!/^[A-Za-z0-9]{22}$/u.test(id)) continue;
        const owner = object(item.owner);
        const ownerId = text(owner.id);
        const total = number(object(item.items).total) ?? number(object(item.tracks).total) ?? 0;
        output.push({
          id,
          provider: "spotify",
          title: text(item.name) || id,
          description: text(item.description),
          itemCount: total,
          ownerLabel: text(owner.display_name) || ownerId,
          url: text(object(item.external_urls).spotify) || `https://open.spotify.com/playlist/${id}`,
          writable: ownerId === account.id || item.collaborative === true,
        });
      }
      const next = text(payload.next);
      path = next ? next.replace("https://api.spotify.com/v1/", "") : undefined;
    }
    return output;
  }

  async snapshot(playlistId: string): Promise<HostedSnapshot> {
    spotifyId(playlistId, "SPOTIFY_PLAYLIST_ID_REQUIRED");
    const details = await this.request<Json>(`playlists/${playlistId}`);
    const account = await this.getAccount();
    const owner = object(details.owner);
    const tracks: HostedTrack[] = [];
    let path: string | undefined = `playlists/${playlistId}/items?limit=50`;
    for (let page = 0; path && page < 100; page += 1) {
      const payload: Json = await this.request<Json>(path);
      for (const row of array(payload.items)) {
        const wrapper = object(row);
        const track = toTrack(wrapper.item ?? wrapper.track, tracks.length);
        if (track) tracks.push(track);
      }
      const next = text(payload.next);
      path = next ? next.replace("https://api.spotify.com/v1/", "") : undefined;
    }
    return {
      playlist: {
        id: playlistId,
        provider: "spotify",
        title: text(details.name) || playlistId,
        description: text(details.description),
        itemCount: tracks.length,
        ownerLabel: text(owner.display_name) || text(owner.id),
        url: text(object(details.external_urls).spotify) || `https://open.spotify.com/playlist/${playlistId}`,
        writable: text(owner.id) === account.id || details.collaborative === true,
      },
      tracks,
      version: text(details.snapshot_id) || `${playlistId}:${tracks.length}`,
    };
  }

  async search(query: string, limit = 5): Promise<HostedCandidate[]> {
    const payload = await this.request<Json>(`search?${new URLSearchParams({
      q: query.slice(0, 250),
      type: "track",
      limit: String(Math.max(1, Math.min(10, limit))),
    })}`);
    return array(object(payload.tracks).items)
      .map(toCandidate)
      .filter((candidate): candidate is HostedCandidate => Boolean(candidate));
  }

  async validateTargetIds(ids: string[]): Promise<Set<string>> {
    const valid = new Set<string>();
    const unique = [...new Set(ids)].filter((id) => /^[A-Za-z0-9]{22}$/u.test(id));
    for (let index = 0; index < unique.length; index += 50) {
      const batch = unique.slice(index, index + 50);
      const payload = await this.request<Json>(`tracks?ids=${encodeURIComponent(batch.join(","))}`);
      for (const raw of array(payload.tracks)) {
        const track = object(raw);
        const id = text(track.id);
        if (id && track.is_playable !== false && !track.restrictions) valid.add(id);
      }
    }
    return valid;
  }

  async createPlaylist(input: { title: string; description: string; public: boolean }): Promise<{ id: string; url: string }> {
    const payload = await this.request<Json>("me/playlists", {
      method: "POST",
      body: JSON.stringify({ name: input.title.slice(0, 100), description: input.description.slice(0, 300), public: input.public }),
    });
    const id = spotifyId(text(payload.id), "SPOTIFY_CREATE_UNVERIFIED");
    return { id, url: text(object(payload.external_urls).spotify) || `https://open.spotify.com/playlist/${id}` };
  }

  async append(playlistId: string, targetIds: string[]): Promise<{ addedIds: string[]; failures: Array<{ id: string; error: string }> }> {
    spotifyId(playlistId, "SPOTIFY_PLAYLIST_ID_REQUIRED");
    const addedIds: string[] = [];
    const failures: Array<{ id: string; error: string }> = [];
    for (let index = 0; index < targetIds.length; index += 100) {
      const batch = targetIds.slice(index, index + 100);
      try {
        await this.request<Json>(`playlists/${playlistId}/items`, {
          method: "POST",
          body: JSON.stringify({ uris: batch.map((id) => `spotify:track:${spotifyId(id, "SPOTIFY_TRACK_ID_REQUIRED")}`) }),
        });
        addedIds.push(...batch);
      } catch (error) {
        const message = error instanceof Error ? error.message : "SPOTIFY_APPEND_FAILED";
        failures.push(...batch.map((id) => ({ id, error: message })));
      }
    }
    return { addedIds, failures };
  }
}
