import type { Provider, ProviderEntityRef } from "./types";

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID = /^[A-Za-z0-9_-]{10,128}$/;
const SOUNDCLOUD_RESERVED = new Set([
  "discover",
  "search",
  "stream",
  "you",
  "upload",
  "settings",
  "terms-of-use",
  "pages",
]);

function ensureHttps(url: URL) {
  if (url.protocol !== "https:") throw new Error("UNSUPPORTED_SCHEME");
  if (url.username || url.password || (url.port && url.port !== "443")) throw new Error("UNSAFE_URL_AUTHORITY");
}

function baseRef(provider: Provider, entityKind: ProviderEntityRef["entityKind"], canonical: URL): ProviderEntityRef {
  return {
    provider,
    entityKind,
    providerUriOrUrl: canonical.toString(),
    containsSecretUrl: false,
    redactedDisplayUrl: canonical.toString(),
    validationStatus: "USER_SELECTED_REAL_URL",
    attributionUrl: canonical.toString(),
  };
}

export function parseSpotifyUrl(value: string): ProviderEntityRef {
  const url = new URL(value);
  ensureHttps(url);
  if (url.hostname !== "open.spotify.com") throw new Error("WRONG_SPOTIFY_ORIGIN");
  const parts = url.pathname.split("/").filter(Boolean);
  const resource = parts[0]?.startsWith("intl-") ? parts.slice(1) : parts;
  const [kind, id] = resource;
  if ((kind !== "track" && kind !== "playlist") || !SPOTIFY_ID.test(id ?? "")) {
    throw new Error("UNSUPPORTED_SPOTIFY_RESOURCE");
  }
  const canonical = new URL(`https://open.spotify.com/${kind}/${id}`);
  const ref = baseRef("spotify", kind, canonical);
  ref.providerEntityId = id;
  return ref;
}

export function parseYoutubeUrl(value: string): ProviderEntityRef {
  const url = new URL(value);
  ensureHttps(url);
  const hosts = new Set(["www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
  if (!hosts.has(url.hostname)) throw new Error("WRONG_YOUTUBE_ORIGIN");
  let videoId: string | undefined;
  let playlistId: string | undefined;
  if (url.hostname === "youtu.be") videoId = url.pathname.split("/").filter(Boolean)[0];
  else if (url.pathname === "/watch") videoId = url.searchParams.get("v") ?? undefined;
  else if (url.pathname === "/playlist") playlistId = url.searchParams.get("list") ?? undefined;
  if (videoId) {
    if (!YOUTUBE_VIDEO_ID.test(videoId)) throw new Error("INVALID_YOUTUBE_VIDEO_ID");
    const canonical = new URL("https://www.youtube.com/watch");
    canonical.searchParams.set("v", videoId);
    const ref = baseRef("youtube", "video", canonical);
    ref.providerEntityId = videoId;
    ref.videoId = videoId;
    return ref;
  }
  if (playlistId) {
    if (!YOUTUBE_PLAYLIST_ID.test(playlistId)) throw new Error("INVALID_YOUTUBE_PLAYLIST_ID");
    const canonical = new URL("https://www.youtube.com/playlist");
    canonical.searchParams.set("list", playlistId);
    const ref = baseRef("youtube", "playlist", canonical);
    ref.providerEntityId = playlistId;
    ref.playlistId = playlistId;
    return ref;
  }
  throw new Error("UNSUPPORTED_YOUTUBE_RESOURCE");
}

export function parseSoundcloudUrl(value: string): ProviderEntityRef {
  const url = new URL(value);
  ensureHttps(url);
  if (url.hostname !== "soundcloud.com" && url.hostname !== "www.soundcloud.com") {
    throw new Error("WRONG_SOUNDCLOUD_ORIGIN");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || SOUNDCLOUD_RESERVED.has(parts[0].toLowerCase())) {
    throw new Error("UNSUPPORTED_SOUNDCLOUD_RESOURCE");
  }
  const playlist = parts.length === 3 && parts[1] === "sets";
  if (parts.length === 3 && !playlist) throw new Error("UNSUPPORTED_SOUNDCLOUD_RESOURCE");
  const containsSecret = [...url.searchParams.keys()].some((key) => /secret|token/i.test(key)) || parts.some((part) => /^s-[A-Za-z0-9_-]+$/.test(part));
  const canonical = new URL(`https://soundcloud.com/${parts.join("/")}`);
  const redacted = new URL(canonical);
  if (containsSecret) {
    for (const [key] of url.searchParams) redacted.searchParams.set(key, "REDACTED");
  }
  const ref = baseRef("soundcloud", playlist ? "playlist" : "track", canonical);
  ref.providerEntityId = canonical.toString();
  ref.containsSecretUrl = containsSecret;
  ref.providerUriOrUrl = containsSecret ? url.toString() : canonical.toString();
  ref.redactedDisplayUrl = containsSecret ? redacted.toString() : canonical.toString();
  ref.attributionUrl = ref.redactedDisplayUrl;
  return ref;
}

export function parseProviderUrl(provider: Provider, value: string): ProviderEntityRef {
  if (value.length > 2_048) throw new Error("URL_TOO_LONG");
  if (provider === "spotify") return parseSpotifyUrl(value);
  if (provider === "youtube") return parseYoutubeUrl(value);
  return parseSoundcloudUrl(value);
}

export function buildSearchUrl(provider: Provider, query: string): string {
  const normalized = query.trim().slice(0, 300);
  if (!normalized) throw new Error("EMPTY_SEARCH_QUERY");
  if (provider === "spotify") return `https://open.spotify.com/search/${encodeURIComponent(normalized)}`;
  if (provider === "soundcloud") return `https://soundcloud.com/search/sounds?q=${encodeURIComponent(normalized)}`;
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(normalized)}`;
}

export function assertYoutubeVideoRef(ref: ProviderEntityRef): asserts ref is ProviderEntityRef & { videoId: string; providerEntityId: string } {
  if (ref.provider !== "youtube" || ref.entityKind !== "video" || !ref.videoId || !YOUTUBE_VIDEO_ID.test(ref.videoId)) {
    throw new Error("YOUTUBE_VIDEO_ID_REQUIRED");
  }
}
