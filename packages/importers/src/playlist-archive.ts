import { strFromU8, unzipSync } from "fflate";
import { parsePlaylistFile, type ImportProvider, type ParsedPlaylistOption } from "./playlist-file";

const MAX_COMPRESSED_BYTES = 25_000_000;
const MAX_UNCOMPRESSED_BYTES = 75_000_000;
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_PLAYLISTS = 500;
const SUPPORTED_ENTRY = /\.(?:json|csv|tsv|m3u8?|txt)$/iu;

export type PlaylistArchiveInput = {
  fileName: string;
  data: Uint8Array;
  provider: ImportProvider;
};

function isZip(input: PlaylistArchiveInput): boolean {
  return input.fileName.toLocaleLowerCase("en-US").endsWith(".zip")
    || (input.data[0] === 0x50 && input.data[1] === 0x4b);
}

function displayName(entryName: string): string {
  return entryName.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "playlist";
}

export function parsePlaylistArchive(input: PlaylistArchiveInput): ParsedPlaylistOption[] {
  if (!input.data.length) throw new Error("IMPORT_FILE_EMPTY");
  if (input.data.length > MAX_COMPRESSED_BYTES) throw new Error("IMPORT_FILE_TOO_LARGE");
  if (!isZip(input)) {
    return parsePlaylistFile({ content: strFromU8(input.data), fileName: input.fileName, provider: input.provider });
  }

  let uncompressedBytes = 0;
  let acceptedEntries = 0;
  let archiveTooLarge = false;
  const files = unzipSync(input.data, {
    filter(file) {
      uncompressedBytes += file.originalSize;
      if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) archiveTooLarge = true;
      if (archiveTooLarge || !SUPPORTED_ENTRY.test(file.name)) return false;
      acceptedEntries += 1;
      return acceptedEntries <= MAX_ARCHIVE_ENTRIES;
    },
  });
  if (archiveTooLarge) throw new Error("IMPORT_ARCHIVE_UNCOMPRESSED_LIMIT");
  if (acceptedEntries > MAX_ARCHIVE_ENTRIES) throw new Error("IMPORT_ARCHIVE_ENTRY_LIMIT");

  const options: ParsedPlaylistOption[] = [];
  for (const [entryName, bytes] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const name = displayName(entryName);
    try {
      const parsed = parsePlaylistFile({ content: strFromU8(bytes), fileName: name, provider: input.provider });
      for (const option of parsed) {
        options.push({
          ...option,
          key: `${entryName}:${option.key}`,
          warnings: [`ARCHIVE_ENTRY:${name}`, ...option.warnings],
        });
        if (options.length >= MAX_PLAYLISTS) break;
      }
    } catch {
      // Provider exports contain unrelated account/history files. Only files
      // that independently parse as playlists are offered to the user.
    }
    if (options.length >= MAX_PLAYLISTS) break;
  }
  if (!options.length) throw new Error("IMPORT_ARCHIVE_NO_SUPPORTED_PLAYLISTS");
  return options;
}
