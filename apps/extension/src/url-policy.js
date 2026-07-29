import { LIMITS } from "./constants.js";
import { fail } from "./errors.js";

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/u;
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const YOUTUBE_PLAYLIST_ID = /^[A-Za-z0-9_-]{10,128}$/u;
const SOUNDCLOUD_SLUG = /^[A-Za-z0-9_-]{1,160}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const UTF8 = new TextEncoder();

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);
const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "www.soundcloud.com"]);
const SOUNDCLOUD_RESERVED = new Set([
  "charts",
  "discover",
  "mobile",
  "pages",
  "search",
  "settings",
  "stream",
  "terms-of-use",
  "upload",
  "you",
]);

function parseUrl(rawUrl) {
  if (typeof rawUrl !== "string" || UTF8.encode(rawUrl).byteLength > LIMITS.urlBytes) {
    fail("INVALID_URL");
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail("INVALID_URL");
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    fail("UNSUPPORTED_ORIGIN");
  }
  return url;
}

function providerForHost(hostname) {
  if (hostname === "open.spotify.com") return "spotify";
  if (YOUTUBE_HOSTS.has(hostname)) return "youtube";
  if (SOUNDCLOUD_HOSTS.has(hostname)) return "soundcloud";
  return null;
}

function splitPath(pathname) {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        fail("INVALID_URL");
      }
    });
}

function parseSpotify(url) {
  const segments = splitPath(url.pathname);
  if (/^intl-[A-Za-z]{2,8}$/u.test(segments[0] || "")) segments.shift();
  const [kind, id, ...rest] = segments;
  if (rest.length !== 0 || !["track", "playlist"].includes(kind) || !SPOTIFY_ID.test(id || "")) {
    fail("UNSUPPORTED_RESOURCE");
  }
  return {
    provider: "spotify",
    resourceKind: kind,
    providerEntityId: id,
    canonicalUrl: `https://open.spotify.com/${kind}/${id}`,
    redactedDisplayUrl: `https://open.spotify.com/${kind}/${id}`,
    containsSecret: false,
  };
}

function parseYouTube(url) {
  let videoId = null;
  let playlistId = null;

  if (url.hostname === "youtu.be") {
    const segments = splitPath(url.pathname);
    if (segments.length !== 1 || !YOUTUBE_VIDEO_ID.test(segments[0] || "")) {
      fail("UNSUPPORTED_RESOURCE");
    }
    videoId = segments[0];
  } else if (url.pathname === "/watch") {
    videoId = url.searchParams.get("v");
    playlistId = url.searchParams.get("list");
    if (!YOUTUBE_VIDEO_ID.test(videoId || "")) fail("YOUTUBE_VIDEO_ID_REQUIRED");
    if (playlistId !== null && !YOUTUBE_PLAYLIST_ID.test(playlistId)) playlistId = null;
  } else if (url.pathname === "/playlist") {
    playlistId = url.searchParams.get("list");
    if (!YOUTUBE_PLAYLIST_ID.test(playlistId || "")) fail("UNSUPPORTED_RESOURCE");
  } else if (url.pathname.startsWith("/shorts/")) {
    const segments = splitPath(url.pathname);
    if (segments.length !== 2 || segments[0] !== "shorts" || !YOUTUBE_VIDEO_ID.test(segments[1] || "")) {
      fail("UNSUPPORTED_RESOURCE");
    }
    videoId = segments[1];
  } else {
    fail("UNSUPPORTED_RESOURCE");
  }

  if (videoId) {
    const canonicalUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    return {
      provider: "youtube",
      resourceKind: "video",
      providerEntityId: videoId,
      videoId,
      ...(playlistId ? { playlistId } : {}),
      canonicalUrl,
      redactedDisplayUrl: canonicalUrl,
      containsSecret: false,
    };
  }

  const canonicalUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
  return {
    provider: "youtube",
    resourceKind: "playlist",
    providerEntityId: playlistId,
    playlistId,
    canonicalUrl,
    redactedDisplayUrl: canonicalUrl,
    containsSecret: false,
  };
}

function isSecretSegment(segment) {
  return /^s-[A-Za-z0-9_-]{4,}$/u.test(segment || "");
}

function soundCloudQuery(url) {
  const preserved = new URLSearchParams();
  let containsSecret = false;
  for (const [key, value] of url.searchParams.entries()) {
    const lower = key.toLowerCase();
    if (lower === "si" || lower.startsWith("utm_")) continue;
    containsSecret = true;
    preserved.append(key, value);
  }
  return { preserved, containsSecret };
}

function parseSoundCloud(url) {
  const segments = splitPath(url.pathname);
  if (segments.length < 2 || SOUNDCLOUD_RESERVED.has((segments[0] || "").toLowerCase())) {
    fail("UNSUPPORTED_RESOURCE");
  }
  if (!SOUNDCLOUD_SLUG.test(segments[0] || "")) fail("UNSUPPORTED_RESOURCE");

  let resourceKind;
  let baseSegments;
  let privateSegment = null;

  if (segments[1] === "sets") {
    if (segments.length < 3 || segments.length > 4 || !SOUNDCLOUD_SLUG.test(segments[2] || "")) {
      fail("UNSUPPORTED_RESOURCE");
    }
    if (segments[3] && !isSecretSegment(segments[3])) fail("UNSUPPORTED_RESOURCE");
    resourceKind = "playlist";
    baseSegments = segments.slice(0, 3);
    privateSegment = segments[3] || null;
  } else {
    if (segments.length > 3 || !SOUNDCLOUD_SLUG.test(segments[1] || "")) {
      fail("UNSUPPORTED_RESOURCE");
    }
    if (segments[2] && !isSecretSegment(segments[2])) fail("UNSUPPORTED_RESOURCE");
    resourceKind = "track";
    baseSegments = segments.slice(0, 2);
    privateSegment = segments[2] || null;
  }

  const { preserved, containsSecret: querySecret } = soundCloudQuery(url);
  const containsSecret = Boolean(privateSegment) || querySecret;
  const encodedBase = baseSegments.map(encodeURIComponent).join("/");
  const publicUrl = `https://soundcloud.com/${encodedBase}`;
  let canonicalUrl = publicUrl;
  let redactedDisplayUrl = publicUrl;

  if (privateSegment) {
    canonicalUrl += `/${encodeURIComponent(privateSegment)}`;
    redactedDisplayUrl += "/s-REDACTED";
  }
  const query = preserved.toString();
  if (query) {
    canonicalUrl += `?${query}`;
    redactedDisplayUrl += "?token=REDACTED";
  }

  return {
    provider: "soundcloud",
    resourceKind,
    providerEntityId: publicUrl,
    canonicalUrl,
    redactedDisplayUrl,
    containsSecret,
  };
}

function isSafeProfileSlug(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value !== "." &&
    value !== ".." &&
    !/[\s/?#\\]/u.test(value)
  );
}

export function parseProviderProfileUrl(rawUrl) {
  const url = parseUrl(rawUrl);
  const provider = providerForHost(url.hostname);
  if (!provider) fail("UNSUPPORTED_ORIGIN");
  const segments = splitPath(url.pathname);

  if (provider === "spotify") {
    if (/^intl-[A-Za-z]{2,8}$/u.test(segments[0] || "")) segments.shift();
    if (segments.length !== 2 || segments[0] !== "user" || !isSafeProfileSlug(segments[1])) {
      fail("UNSUPPORTED_PROFILE_TAB");
    }
    return { provider, canonicalUrl: `https://open.spotify.com/user/${encodeURIComponent(segments[1])}` };
  }

  if (provider === "youtube") {
    const [kind, identifier] = segments;
    const handle = segments.length === 1 && kind?.startsWith("@") && isSafeProfileSlug(kind.slice(1));
    const channel = segments.length === 2 && kind === "channel" && /^UC[A-Za-z0-9_-]{22}$/u.test(identifier || "");
    const legacy = segments.length === 2 && (kind === "c" || kind === "user") && isSafeProfileSlug(identifier);
    if (!handle && !channel && !legacy) fail("UNSUPPORTED_PROFILE_TAB");
    const canonicalPath = handle
      ? `/@${encodeURIComponent(kind.slice(1))}`
      : `/${kind}/${encodeURIComponent(identifier)}`;
    return { provider, canonicalUrl: `https://www.youtube.com${canonicalPath}` };
  }

  if (
    segments.length !== 1 ||
    !isSafeProfileSlug(segments[0]) ||
    SOUNDCLOUD_RESERVED.has(segments[0].toLowerCase())
  ) {
    fail("UNSUPPORTED_PROFILE_TAB");
  }
  return { provider, canonicalUrl: `https://soundcloud.com/${encodeURIComponent(segments[0])}` };
}

export function inspectProviderTab(rawUrl) {
  const url = parseUrl(rawUrl);
  const provider = providerForHost(url.hostname);
  if (!provider) fail("UNSUPPORTED_ORIGIN");
  const officialOrigin =
    provider === "spotify"
      ? "https://open.spotify.com"
      : provider === "soundcloud"
        ? "https://soundcloud.com"
        : "https://www.youtube.com";
  let resource = null;
  let serviceTabUrl = null;
  try {
    resource = parseProviderResource(rawUrl);
  } catch {
    // An official provider page is still usable for honest service-tab attestation.
  }
  try {
    serviceTabUrl = parseProviderProfileUrl(rawUrl).canonicalUrl;
  } catch {
    // A provider resource or navigation page is not an account-profile attestation.
  }
  return { provider, officialOrigin, resource, serviceTabUrl };
}

export function parseProviderResource(rawUrl) {
  const url = parseUrl(rawUrl);
  if (url.hostname === "open.spotify.com") return parseSpotify(url);
  if (YOUTUBE_HOSTS.has(url.hostname)) return parseYouTube(url);
  if (SOUNDCLOUD_HOSTS.has(url.hostname)) return parseSoundCloud(url);
  fail("UNSUPPORTED_ORIGIN");
}

function validateQuery(query) {
  if (
    typeof query !== "string" ||
    query.trim() === "" ||
    query.length > LIMITS.queryCharacters ||
    CONTROL_CHARACTERS.test(query)
  ) {
    fail("INVALID_NAVIGATION_TARGET");
  }
  return query.trim();
}

export function buildNavigationTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    fail("INVALID_NAVIGATION_TARGET");
  }

  const { provider, action } = target;
  if (provider === "spotify") {
    if (action === "search") {
      return `https://open.spotify.com/search/${encodeURIComponent(validateQuery(target.query))}`;
    }
    if (action === "track" && SPOTIFY_ID.test(target.trackId || "")) {
      return `https://open.spotify.com/track/${target.trackId}`;
    }
    if (action === "playlist" && SPOTIFY_ID.test(target.playlistId || "")) {
      return `https://open.spotify.com/playlist/${target.playlistId}`;
    }
  }

  if (provider === "youtube") {
    if (action === "search") {
      const url = new URL("https://www.youtube.com/results");
      url.searchParams.set("search_query", validateQuery(target.query));
      return url.href;
    }
    if (action === "video" && YOUTUBE_VIDEO_ID.test(target.videoId || "")) {
      return `https://www.youtube.com/watch?v=${target.videoId}`;
    }
    if (action === "playlist" && YOUTUBE_PLAYLIST_ID.test(target.playlistId || "")) {
      return `https://www.youtube.com/playlist?list=${target.playlistId}`;
    }
    if (action === "playlists-home") return "https://www.youtube.com/feed/playlists";
  }

  if (provider === "soundcloud") {
    if (action === "search") {
      const url = new URL("https://soundcloud.com/search/sounds");
      url.searchParams.set("q", validateQuery(target.query));
      return url.href;
    }
    if (action === "permalink") {
      const parsed = parseProviderResource(target.url);
      if (parsed.provider === "soundcloud") return parsed.canonicalUrl;
    }
  }

  fail("INVALID_NAVIGATION_TARGET");
}

export function providerAndAction(target) {
  buildNavigationTarget(target);
  return { provider: target.provider, action: target.action };
}
