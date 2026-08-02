export type HostedProvider = "spotify" | "youtube";

export type HostedConfig = {
  origin: string;
  secret: string;
  spotifyClientId: string;
  youtubeClientId: string;
  youtubeClientSecret?: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`HOSTED_CONFIG_MISSING_${name}`);
  return value;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("HOSTED_ORIGIN_INVALID");
  }
  return url.origin;
}

export function isHostedMode(): boolean {
  return process.env.PLAYLIST_TRANSFER_HOSTED === "1";
}

export function assertHostedMode(): void {
  if (!isHostedMode()) throw new Error("HOSTED_MODE_DISABLED");
}

export function getHostedConfig(requestUrl?: string): HostedConfig {
  assertHostedMode();
  const configuredOrigin = process.env.PLAYLIST_TRANSFER_PUBLIC_ORIGIN?.trim();
  const inferredOrigin = requestUrl ? new URL(requestUrl).origin : undefined;
  return {
    origin: normalizeOrigin(configuredOrigin || inferredOrigin || required("PLAYLIST_TRANSFER_PUBLIC_ORIGIN")),
    secret: required("PLAYLIST_TRANSFER_HOSTED_SECRET"),
    spotifyClientId: required("PLAYLIST_TRANSFER_SPOTIFY_CLIENT_ID"),
    youtubeClientId: required("PLAYLIST_TRANSFER_YOUTUBE_CLIENT_ID"),
    youtubeClientSecret: process.env.PLAYLIST_TRANSFER_YOUTUBE_CLIENT_SECRET?.trim() || undefined,
  };
}

export function providerCallbackUrl(config: HostedConfig, provider: HostedProvider): string {
  return `${config.origin}/api/hosted/oauth/${provider}/callback`;
}
