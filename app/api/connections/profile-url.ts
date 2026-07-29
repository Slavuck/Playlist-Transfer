export type GuidedProfileProvider = "spotify" | "soundcloud" | "youtube";

const officialHosts: Record<GuidedProfileProvider, ReadonlySet<string>> = {
  spotify: new Set(["open.spotify.com"]),
  soundcloud: new Set(["soundcloud.com", "www.soundcloud.com"]),
  youtube: new Set(["youtube.com", "www.youtube.com", "music.youtube.com"]),
};

const soundcloudReserved = new Set([
  "charts",
  "discover",
  "jobs",
  "pages",
  "search",
  "settings",
  "stream",
  "terms-of-use",
  "upload",
  "you",
]);

function decodedSegments(pathname: string): string[] {
  const raw = pathname.split("/").filter(Boolean);
  try {
    return raw.map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error("OFFICIAL_PROVIDER_PROFILE_URL_REQUIRED");
  }
}

function isSafeSlug(value: string): boolean {
  return Boolean(value)
    && value !== "."
    && value !== ".."
    && !/[\s/?#\\]/u.test(value)
    && value.length <= 128;
}

export function normalizeOfficialProfileUrl(provider: GuidedProfileProvider, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OFFICIAL_PROVIDER_PROFILE_URL_REQUIRED");
  }
  if (url.protocol !== "https:"
    || !officialHosts[provider].has(url.hostname)
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash) {
    throw new Error("OFFICIAL_PROVIDER_PROFILE_URL_REQUIRED");
  }
  const segments = decodedSegments(url.pathname);
  let valid = false;
  if (provider === "spotify") {
    valid = segments.length === 2 && segments[0] === "user" && isSafeSlug(segments[1]!);
  } else if (provider === "youtube") {
    valid = (segments.length === 1 && segments[0]!.startsWith("@") && isSafeSlug(segments[0]!.slice(1)))
      || (segments.length === 2 && segments[0] === "channel" && /^UC[A-Za-z0-9_-]{22}$/.test(segments[1]!))
      || (segments.length === 2 && (segments[0] === "c" || segments[0] === "user") && isSafeSlug(segments[1]!));
  } else {
    valid = segments.length === 1
      && isSafeSlug(segments[0]!)
      && !soundcloudReserved.has(segments[0]!.toLocaleLowerCase("en-US"));
  }
  if (!valid) throw new Error("OFFICIAL_PROVIDER_PROFILE_URL_REQUIRED");

  const canonicalHost = provider === "soundcloud"
    ? "soundcloud.com"
    : provider === "youtube" && url.hostname === "youtube.com"
      ? "www.youtube.com"
      : url.hostname;
  const canonicalPath = `/${segments.map((segment) => encodeURIComponent(segment).replace(/%40/gi, "@")).join("/")}`;
  return `https://${canonicalHost}${canonicalPath}`;
}
