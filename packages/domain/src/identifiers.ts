import type { Provider, ProviderEntityKind } from "./provider.js";

export interface ParsedProviderIdentifier {
  readonly provider: Provider;
  readonly entityKind: ProviderEntityKind;
  readonly providerEntityId: string;
  readonly canonicalUriOrUrl: string;
  readonly containsSecretUrl: boolean;
  readonly redactedDisplayUrl: string;
  readonly videoId?: string;
}

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID = /^[A-Za-z0-9_-]{10,128}$/;
const SOUNDCLOUD_URN = /^(?:urn:)?soundcloud:(tracks|playlists):([0-9]+)$/;

function parseHttpsUrl(input: string): URL | null {
  try {
    const url = new URL(input.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function stripSpotifyLocalePrefix(parts: string[]): string[] {
  return parts[0]?.startsWith("intl-") ? parts.slice(1) : parts;
}

export function parseSpotifyIdentifier(
  input: string,
  expectedKind?: "track" | "playlist",
): ParsedProviderIdentifier | null {
  const value = input.trim();
  let kind = expectedKind;
  let id: string | undefined;

  if (SPOTIFY_ID.test(value) && expectedKind) {
    id = value;
  } else {
    const uri = /^spotify:(track|playlist):([A-Za-z0-9]{22})$/i.exec(value);
    if (uri) {
      kind = uri[1]!.toLowerCase() as "track" | "playlist";
      id = uri[2];
    } else {
      const url = parseHttpsUrl(value);
      if (!url || !["open.spotify.com", "play.spotify.com"].includes(url.hostname.toLowerCase())) {
        return null;
      }
      const parts = stripSpotifyLocalePrefix(url.pathname.split("/").filter(Boolean));
      if ((parts[0] !== "track" && parts[0] !== "playlist") || !parts[1] || !SPOTIFY_ID.test(parts[1])) {
        return null;
      }
      kind = parts[0];
      id = parts[1];
    }
  }

  if (!kind || !id || (expectedKind && kind !== expectedKind)) return null;
  const canonical = `https://open.spotify.com/${kind}/${id}`;
  return {
    provider: "spotify",
    entityKind: kind,
    providerEntityId: id,
    canonicalUriOrUrl: `spotify:${kind}:${id}`,
    containsSecretUrl: false,
    redactedDisplayUrl: canonical,
  };
}

export function parseSpotifyTrackId(input: string): string | null {
  return parseSpotifyIdentifier(input, "track")?.providerEntityId ?? null;
}

export function parseYoutubeVideoIdentifier(input: string): ParsedProviderIdentifier | null {
  const value = input.trim();
  let videoId: string | null = YOUTUBE_VIDEO_ID.test(value) ? value : null;

  if (!videoId) {
    const url = parseHttpsUrl(value);
    if (!url) return null;
    const host = url.hostname.toLowerCase();
    if (host === "youtu.be") {
      videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
    } else if (
      ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(host)
    ) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.pathname === "/watch") videoId = url.searchParams.get("v");
      else if (["shorts", "embed", "live"].includes(parts[0] ?? "")) videoId = parts[1] ?? null;
    } else {
      return null;
    }
  }

  if (!videoId || !YOUTUBE_VIDEO_ID.test(videoId)) return null;
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;
  return {
    provider: "youtube",
    entityKind: "video",
    providerEntityId: videoId,
    videoId,
    canonicalUriOrUrl: canonical,
    containsSecretUrl: false,
    redactedDisplayUrl: canonical,
  };
}

export function parseYoutubeVideoId(input: string): string | null {
  return parseYoutubeVideoIdentifier(input)?.videoId ?? null;
}

export function parseYoutubePlaylistIdentifier(input: string): ParsedProviderIdentifier | null {
  const value = input.trim();
  // A bare 11-character value is a video ID, not sufficient playlist evidence.
  let id = YOUTUBE_PLAYLIST_ID.test(value) && !YOUTUBE_VIDEO_ID.test(value) ? value : null;
  if (!id) {
    const url = parseHttpsUrl(value);
    if (!url || !["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(url.hostname.toLowerCase())) {
      return null;
    }
    id = url.searchParams.get("list");
  }
  if (!id || !YOUTUBE_PLAYLIST_ID.test(id)) return null;
  const canonical = `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`;
  return {
    provider: "youtube",
    entityKind: "playlist",
    providerEntityId: id,
    canonicalUriOrUrl: canonical,
    containsSecretUrl: false,
    redactedDisplayUrl: canonical,
  };
}

export function parseYoutubePlaylistId(input: string): string | null {
  return parseYoutubePlaylistIdentifier(input)?.providerEntityId ?? null;
}

export function parseSoundcloudIdentifier(
  input: string,
  expectedKind?: "track" | "playlist",
): ParsedProviderIdentifier | null {
  const value = input.trim();
  const urn = SOUNDCLOUD_URN.exec(value);
  if (urn) {
    const kind = urn[1] === "tracks" ? "track" : "playlist";
    if (expectedKind && kind !== expectedKind) return null;
    const canonicalUrn = `soundcloud:${urn[1]}:${urn[2]}`;
    return {
      provider: "soundcloud",
      entityKind: kind,
      providerEntityId: canonicalUrn,
      canonicalUriOrUrl: canonicalUrn,
      containsSecretUrl: false,
      redactedDisplayUrl: canonicalUrn,
    };
  }

  const url = parseHttpsUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "api.soundcloud.com" && ["tracks", "playlists"].includes(parts[0] ?? "") && /^\d+$/.test(parts[1] ?? "")) {
    const kind = parts[0] === "tracks" ? "track" : "playlist";
    if (expectedKind && kind !== expectedKind) return null;
    const canonicalUrn = `soundcloud:${parts[0]}:${parts[1]}`;
    return {
      provider: "soundcloud",
      entityKind: kind,
      providerEntityId: canonicalUrn,
      canonicalUriOrUrl: canonicalUrn,
      containsSecretUrl: false,
      redactedDisplayUrl: canonicalUrn,
    };
  }

  if (host !== "soundcloud.com" && host !== "www.soundcloud.com") return null;
  const isPlaylist = parts.length === 3 && parts[1] === "sets";
  const isTrack = parts.length === 2 && parts[0] !== "discover" && parts[0] !== "search";
  const kind = isPlaylist ? "playlist" : isTrack ? "track" : null;
  if (!kind || (expectedKind && kind !== expectedKind)) return null;

  const canonicalPath = `https://soundcloud.com/${parts.map(encodeURIComponent).join("/")}`;
  const secretToken = url.searchParams.get("secret_token");
  const operational = secretToken
    ? `${canonicalPath}?secret_token=${encodeURIComponent(secretToken)}`
    : canonicalPath;
  return {
    provider: "soundcloud",
    entityKind: kind,
    // A guided permalink is itself the provider-issued stable reference; never fabricate a URN.
    providerEntityId: canonicalPath,
    canonicalUriOrUrl: operational,
    containsSecretUrl: Boolean(secretToken),
    redactedDisplayUrl: canonicalPath,
  };
}

export function parseSoundcloudTrackReference(input: string): ParsedProviderIdentifier | null {
  return parseSoundcloudIdentifier(input, "track");
}

export function parseProviderTrackIdentifier(provider: Provider, input: string): ParsedProviderIdentifier | null {
  if (provider === "spotify") return parseSpotifyIdentifier(input, "track");
  if (provider === "youtube") return parseYoutubeVideoIdentifier(input);
  return parseSoundcloudIdentifier(input, "track");
}
