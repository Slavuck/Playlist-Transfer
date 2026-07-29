export type ImportProvider = "spotify" | "soundcloud" | "youtube";

export type ImportedTrack = {
  title: string;
  artist: string;
  durationSeconds?: number;
  url: string;
  unavailable: false;
};

export type ParsedPlaylistOption = {
  key: string;
  title: string;
  description: string;
  ownerLabel?: string;
  playlistUrl?: string;
  tracks: ImportedTrack[];
  sourceItemCount: number;
  format: "JSON" | "CSV" | "M3U" | "TEXT";
  warnings: string[];
};

const MAX_TRACKS = 10_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function finiteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function canonicalResourceUrl(provider: ImportProvider, value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const spotify = /^spotify:(track|playlist):([A-Za-z0-9]{22})$/u.exec(trimmed);
  if (spotify) return `https://open.spotify.com/${spotify[1]}/${spotify[2]}`;
  if (provider === "youtube" && /^[A-Za-z0-9_-]{11}$/u.test(trimmed)) return `https://www.youtube.com/watch?v=${trimmed}`;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function durationSeconds(row: Record<string, unknown>): number | undefined {
  const explicitSeconds = finiteNumber(row.durationSeconds, row.duration_seconds, row.seconds);
  if (explicitSeconds !== undefined && explicitSeconds > 0 && explicitSeconds <= 86_400) return explicitSeconds;
  const milliseconds = finiteNumber(row.durationMs, row.duration_ms, row.msDuration);
  if (milliseconds !== undefined && milliseconds > 0) return milliseconds / 1_000;
  const ambiguous = finiteNumber(row.duration);
  if (ambiguous !== undefined && ambiguous > 0 && ambiguous <= 86_400) return ambiguous;
  return undefined;
}

function trackFromUnknown(value: unknown, provider: ImportProvider, index: number): ImportedTrack | undefined {
  const wrapper = record(value);
  if (!wrapper) return undefined;
  const nested = record(wrapper.track) ?? record(wrapper.item) ?? wrapper;
  const url = canonicalResourceUrl(provider, text(
    nested.url,
    nested.uri,
    nested.trackUri,
    nested.track_uri,
    nested.track_url,
    nested.video_url,
    nested.video_id,
    nested.song_url,
    nested.spotify_track_uri,
    nested.spotify_uri,
    nested.permalink_url,
    nested.providerUriOrUrl,
    wrapper.url,
    wrapper.uri,
    wrapper.trackUri,
  ));
  if (!url) return undefined;
  return {
    title: text(nested.title, nested.name, nested.trackName, nested.track_name, nested.track_title, nested.video_title, nested.song_title, nested.song) ?? `Imported target ${index + 1}`,
    artist: text(nested.artist, nested.artistName, nested.artist_name, nested.artist_names, nested.channelTitle, nested.uploader) ?? "",
    durationSeconds: durationSeconds(nested),
    url,
    unavailable: false,
  };
}

function playlistUrlFromRow(row: Record<string, unknown>, provider: ImportProvider): string | undefined {
  const candidate = canonicalResourceUrl(provider, text(row.playlistUrl, row.playlist_url, row.playlistUri, row.playlist_uri, row.uri, row.url));
  if (!candidate) return undefined;
  if (provider === "spotify") return candidate.includes("/playlist/") ? candidate : undefined;
  if (provider === "youtube") return candidate.includes("/playlist?") ? candidate : undefined;
  return candidate.includes("/sets/") ? candidate : undefined;
}

function fallbackTitle(fileName: string): string {
  return fileName.replace(/\.[^.]+$/u, "").trim() || "Imported playlist";
}

function buildOption(
  value: unknown,
  provider: ImportProvider,
  fileName: string,
  format: ParsedPlaylistOption["format"],
  key: string,
): ParsedPlaylistOption {
  const row = record(value) ?? {};
  const rawItems = Array.isArray(row.tracks) ? row.tracks
    : Array.isArray(row.items) ? row.items
      : Array.isArray(value) ? value
        : [];
  const consideredItems = rawItems.slice(0, MAX_TRACKS);
  const tracks = consideredItems.flatMap((item, index) => {
    const parsed = trackFromUnknown(item, provider, index);
    return parsed ? [parsed] : [];
  });
  const skipped = Math.max(0, consideredItems.length - tracks.length);
  const warnings = [
    ...(rawItems.length > MAX_TRACKS ? [`TRACK_LIMIT_APPLIED:${MAX_TRACKS}`] : []),
    ...(skipped > 0 ? [`ROWS_WITHOUT_VALID_TRACK_URL_SKIPPED:${skipped}`] : []),
  ];
  return {
    key,
    title: text(row.title, row.name, row.playlistName, row.playlist_name) ?? fallbackTitle(fileName),
    description: text(row.description) ?? "",
    ownerLabel: text(row.ownerLabel, row.owner, row.owner_name),
    playlistUrl: playlistUrlFromRow(row, provider),
    tracks,
    sourceItemCount: rawItems.length,
    format,
    warnings,
  };
}

function parseJson(content: string, provider: ImportProvider, fileName: string): ParsedPlaylistOption[] {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error("IMPORT_JSON_INVALID"); }
  const root = record(parsed);
  const playlists = root && Array.isArray(root.playlists) ? root.playlists : undefined;
  const candidates = playlists ?? (Array.isArray(parsed) && parsed.some((item) => record(item)?.items || record(item)?.tracks) ? parsed : [parsed]);
  return candidates.map((value, index) => buildOption(value, provider, fileName, "JSON", `json:${index}`));
}

function parseCsvRows(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === '"') {
      if (quoted && content[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(field); field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && content[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function parseCsv(content: string, provider: ImportProvider, fileName: string): ParsedPlaylistOption[] {
  const firstLine = content.split(/\r?\n/u, 1)[0] ?? "";
  const delimiter = firstLine.includes("\t") ? "\t" : ",";
  const rows = parseCsvRows(content, delimiter);
  if (rows.length < 2) throw new Error("IMPORT_CSV_EMPTY");
  const headers = rows[0].map((header) => header.trim().toLowerCase().replace(/[ -]+/gu, "_"));
  const objects = rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index]?.trim() ?? ""])));
  const tracks = objects.flatMap((item, index) => {
    const parsed = trackFromUnknown(item, provider, index);
    return parsed ? [parsed] : [];
  });
  const first = objects[0] ?? {};
  return [{
    key: "csv:0",
    title: text(first.playlist_title, first.playlist_name) ?? fallbackTitle(fileName),
    description: text(first.description) ?? "",
    ownerLabel: text(first.owner, first.owner_label),
    playlistUrl: playlistUrlFromRow(first, provider),
    tracks: tracks.slice(0, MAX_TRACKS),
    sourceItemCount: objects.length,
    format: "CSV",
    warnings: [
      ...(tracks.length === 0 ? ["NO_VALID_TRACK_URLS_FOUND"] : []),
      ...(tracks.length > MAX_TRACKS ? [`TRACK_LIMIT_APPLIED:${MAX_TRACKS}`] : []),
      ...(objects.length > tracks.length ? [`ROWS_WITHOUT_VALID_TRACK_URL_SKIPPED:${objects.length - tracks.length}`] : []),
    ],
  }];
}

function parseM3u(content: string, provider: ImportProvider, fileName: string): ParsedPlaylistOption[] {
  const lines = content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const titleLine = lines.find((line) => /^#PLAYLIST:/iu.test(line));
  const sourceItemCount = lines.filter((line) => !line.startsWith("#")).length;
  const tracks: ImportedTrack[] = [];
  let pending: { title?: string; artist?: string; durationSeconds?: number } = {};
  for (const line of lines) {
    if (/^#EXTINF:/iu.test(line)) {
      const match = /^#EXTINF:([^,]*),(.*)$/iu.exec(line);
      const label = match?.[2]?.trim() ?? "";
      const split = label.indexOf(" - ");
      pending = {
        durationSeconds: match && Number(match[1]) > 0 ? Number(match[1]) : undefined,
        artist: split > 0 ? label.slice(0, split).trim() : "",
        title: split > 0 ? label.slice(split + 3).trim() : label,
      };
      continue;
    }
    if (line.startsWith("#")) continue;
    const url = canonicalResourceUrl(provider, line);
    if (!url) continue;
    tracks.push({
      title: pending.title || `Imported target ${tracks.length + 1}`,
      artist: pending.artist ?? "",
      durationSeconds: pending.durationSeconds,
      url,
      unavailable: false,
    });
    pending = {};
    if (tracks.length >= MAX_TRACKS) break;
  }
  return [{ key: "m3u:0", title: titleLine?.replace(/^#PLAYLIST:/iu, "").trim() || fallbackTitle(fileName), description: "", tracks, sourceItemCount, format: "M3U", warnings: [...(sourceItemCount > MAX_TRACKS ? [`TRACK_LIMIT_APPLIED:${MAX_TRACKS}`] : []), ...(tracks.length ? [] : ["NO_VALID_TRACK_URLS_FOUND"])] }];
}

function parseText(content: string, provider: ImportProvider, fileName: string): ParsedPlaylistOption[] {
  const rows = content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const consideredRows = rows.slice(0, MAX_TRACKS);
  const tracks = consideredRows.flatMap((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    const rawUrl = parts.length >= 4 ? parts.slice(3).join("|") : parts[0];
    const url = canonicalResourceUrl(provider, rawUrl);
    if (!url) return [];
    const parsedDuration = parts.length >= 4 ? Number(parts[2]) : undefined;
    return [{
      title: parts.length >= 4 && parts[0] ? parts[0] : `Imported target ${index + 1}`,
      artist: parts.length >= 4 ? parts[1] : "",
      durationSeconds: parsedDuration && Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : undefined,
      url,
      unavailable: false as const,
    }];
  });
  return [{ key: "text:0", title: fallbackTitle(fileName), description: "", tracks, sourceItemCount: rows.length, format: "TEXT", warnings: [...(rows.length > MAX_TRACKS ? [`TRACK_LIMIT_APPLIED:${MAX_TRACKS}`] : []), ...(consideredRows.length > tracks.length ? [`ROWS_WITHOUT_VALID_TRACK_URL_SKIPPED:${consideredRows.length - tracks.length}`] : [])] }];
}

export function parsePlaylistFile(input: { content: string; fileName: string; provider: ImportProvider }): ParsedPlaylistOption[] {
  const content = input.content.replace(/^\uFEFF/u, "").trim();
  if (!content) throw new Error("IMPORT_FILE_EMPTY");
  if (content.length > 25_000_000) throw new Error("IMPORT_FILE_TOO_LARGE");
  const extension = input.fileName.toLowerCase().split(".").pop();
  let options: ParsedPlaylistOption[];
  if (extension === "json" || content.startsWith("{") || content.startsWith("[")) options = parseJson(content, input.provider, input.fileName);
  else if (extension === "m3u" || extension === "m3u8" || content.startsWith("#EXTM3U")) options = parseM3u(content, input.provider, input.fileName);
  else if (extension === "csv" || extension === "tsv") options = parseCsv(content, input.provider, input.fileName);
  else options = parseText(content, input.provider, input.fileName);
  const nonEmpty = options.filter((option) => option.tracks.length > 0);
  if (!nonEmpty.length) throw new Error("IMPORT_NO_VALID_TRACKS");
  return nonEmpty;
}
