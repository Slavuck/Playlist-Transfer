import type { ProviderEntityRef, ValidationResult } from "../../../connectors-core/src/types";
import { spotifyApiCapabilities } from "../../../connectors-core/src/policy";
import {
  defaultSpotApiBridge,
  type SpotApiBridge,
  type SpotApiCommand,
  type SpotApiCredentials,
} from "./bridge";

export type SpotifyCredentials = SpotApiCredentials;

export type SpotifyPlaylist = {
  id: string;
  title: string;
  description: string;
  itemCount: number;
  privacyStatus: "public" | "private";
  ownerId: string;
  ownerLabel: string;
  snapshotId?: string;
  url: string;
  ownership: "API_OWNED";
};

export type SpotifyTrack = {
  trackId: string;
  title: string;
  artist: string;
  durationMs?: number;
  isrc?: string;
  position: number;
  availability: "AVAILABLE" | "UNAVAILABLE";
  url: string;
};

export type SpotifyCandidate = {
  provider: "spotify";
  providerEntityId: string;
  providerUriOrUrl: string;
  titleRaw: string;
  artistRaw: string;
  durationMs?: number;
  isrc?: string;
  availability: "AVAILABLE" | "UNAVAILABLE";
  searchRank: number;
  validationStatus: "PROVIDER_VALIDATED";
};

type Account = { accountId: string; userId: string; displayName: string; profileUrl: string };
type PlaylistSnapshot = { playlist: SpotifyPlaylist; tracks: SpotifyTrack[]; sourceVersion: string };

function requireSpotifyId(value: string, code: string): void {
  if (!/^[A-Za-z0-9]{22}$/u.test(value)) throw new Error(code);
}

function candidateFromTrack(track: SpotifyTrack, rank: number): SpotifyCandidate {
  return {
    provider: "spotify",
    providerEntityId: track.trackId,
    providerUriOrUrl: track.url,
    titleRaw: track.title,
    artistRaw: track.artist,
    durationMs: track.durationMs,
    isrc: track.isrc,
    availability: track.availability,
    searchRank: rank,
    validationStatus: "PROVIDER_VALIDATED",
  };
}

export class SpotifyApiClient {
  readonly provider = "spotify" as const;
  readonly strategy = "api" as const;
  readonly capabilities = spotifyApiCapabilities;

  constructor(
    private readonly credentials: SpotifyCredentials,
    private readonly options: {
      bridge?: SpotApiBridge;
      onReauthRequired?: () => Promise<void> | void;
    } = {},
  ) {}

  private async request<T>(command: SpotApiCommand): Promise<T> {
    try {
      return await (this.options.bridge ?? defaultSpotApiBridge).run<T>({
        ...command,
        credentials: this.credentials,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "SPOTAPI_SESSION_EXPIRED") {
        await this.options.onReauthRequired?.();
      }
      throw error;
    }
  }

  async getCurrentAccount(): Promise<Account> {
    return this.request<Account>({ operation: "account" });
  }

  async listEligiblePlaylists(): Promise<SpotifyPlaylist[]> {
    const result = await this.request<{ playlists: SpotifyPlaylist[] }>({ operation: "playlists" });
    return result.playlists;
  }

  async getPlaylistSnapshot(playlistId: string): Promise<PlaylistSnapshot> {
    requireSpotifyId(playlistId, "SPOTAPI_PLAYLIST_ID_REQUIRED");
    return this.request<PlaylistSnapshot>({ operation: "playlist_snapshot", playlistId });
  }

  async searchCandidates(query: string, maxResults = 10): Promise<SpotifyCandidate[]> {
    const result = await this.request<{ tracks: SpotifyTrack[] }>({
      operation: "search_tracks",
      query,
      limit: Math.min(10, Math.max(1, maxResults)),
    });
    return result.tracks.map(candidateFromTrack);
  }

  async validateTargetEntity(ref: ProviderEntityRef): Promise<ValidationResult> {
    const providerEntityId = ref.providerEntityId;
    if (ref.provider !== "spotify" || !providerEntityId) throw new Error("SPOTAPI_TRACK_ID_REQUIRED");
    requireSpotifyId(providerEntityId, "SPOTAPI_TRACK_ID_REQUIRED");
    const result = await this.request<{ track: SpotifyTrack }>({ operation: "track", trackId: providerEntityId });
    const candidate = candidateFromTrack(result.track, 0);
    const checkedAt = Date.now();
    return {
      ref: {
        ...ref,
        providerEntityId: candidate.providerEntityId,
        providerUriOrUrl: candidate.providerUriOrUrl,
        redactedDisplayUrl: candidate.providerUriOrUrl,
        attributionUrl: candidate.providerUriOrUrl,
        titleRaw: candidate.titleRaw,
        artistRaw: candidate.artistRaw,
        durationMs: candidate.durationMs,
        validationStatus: "PROVIDER_VALIDATED",
        fetchedAt: checkedAt,
      },
      evidence: { method: "PROVIDER_PRIVATE_API", checkedAt, providerReadBack: true, semanticEqualityProven: false },
      limitations: ["SEMANTIC_EQUALITY_NOT_PROVEN", "SPOTAPI_PRIVATE_API_UNOFFICIAL"],
    };
  }

  async createPlaylist(input: { title: string; description?: string; public: boolean }): Promise<{ id: string; url: string }> {
    return this.request({ operation: "create_playlist", title: input.title });
  }

  async appendItem(playlistId: string, trackId: string): Promise<{ snapshotId: string }> {
    requireSpotifyId(playlistId, "SPOTAPI_PLAYLIST_ID_REQUIRED");
    requireSpotifyId(trackId, "SPOTAPI_TRACK_ID_REQUIRED");
    return this.request({ operation: "append_track", playlistId, trackId });
  }

  async verifyPlaylist(playlistId: string, expectedTrackIds: string[]): Promise<{ verified: boolean; actualTrackIds: string[]; checkedAt: number }> {
    requireSpotifyId(playlistId, "SPOTAPI_PLAYLIST_ID_REQUIRED");
    const result = await this.request<PlaylistSnapshot>({ operation: "verify_playlist", playlistId });
    const actualTrackIds = result.tracks.map((track) => track.trackId);
    let cursor = 0;
    const verified = expectedTrackIds.every((expected) => {
      const found = actualTrackIds.indexOf(expected, cursor);
      if (found < 0) return false;
      cursor = found + 1;
      return true;
    });
    return { verified, actualTrackIds, checkedAt: Date.now() };
  }
}
