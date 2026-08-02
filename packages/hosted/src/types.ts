import type { HostedProvider } from "./config";

export type HostedAccount = {
  id: string;
  label: string;
  url?: string;
};

export type HostedPlaylist = {
  id: string;
  provider: HostedProvider;
  title: string;
  description: string;
  itemCount: number;
  ownerLabel: string;
  url: string;
  writable: boolean;
};

export type HostedTrack = {
  id: string;
  title: string;
  artist: string;
  durationMs?: number;
  isrc?: string;
  url: string;
  position: number;
  available: boolean;
};

export type HostedSnapshot = {
  playlist: HostedPlaylist;
  tracks: HostedTrack[];
  version: string;
};

export type HostedCandidate = {
  id: string;
  provider: HostedProvider;
  title: string;
  artist: string;
  durationMs?: number;
  url: string;
  rank: number;
};

export type DestinationClient = {
  getAccount(): Promise<HostedAccount>;
  listPlaylists(): Promise<HostedPlaylist[]>;
  snapshot(playlistId: string): Promise<HostedSnapshot>;
  search(query: string, limit?: number): Promise<HostedCandidate[]>;
  validateTargetIds(ids: string[]): Promise<Set<string>>;
  createPlaylist(input: { title: string; description: string; public: boolean }): Promise<{ id: string; url: string }>;
  append(playlistId: string, targetIds: string[]): Promise<{ addedIds: string[]; failures: Array<{ id: string; error: string }> }>;
};
