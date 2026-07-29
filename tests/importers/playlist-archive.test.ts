import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { parsePlaylistArchive } from "../../packages/importers/src/playlist-archive.js";

test("Spotify account data ZIP exposes every playlist from Playlist JSON", () => {
  const archive = zipSync({
    "Spotify Account Data/Playlist1.json": strToU8(JSON.stringify({
      playlists: [
        { name: "First", items: [{ track: { trackName: "Song A", artistName: "Artist", trackUri: "spotify:track:AAAAAAAAAAAAAAAAAAAAAA" } }] },
        { name: "Second", items: [{ track: { trackName: "Song B", artistName: "Artist", trackUri: "spotify:track:BBBBBBBBBBBBBBBBBBBBBB" } }] },
      ],
    })),
    "Spotify Account Data/StreamingHistory.json": strToU8(JSON.stringify([{ endTime: "2026-01-01" }])),
  });
  const parsed = parsePlaylistArchive({ provider: "spotify", fileName: "my_spotify_data.zip", data: archive });
  assert.deepEqual(parsed.map((playlist) => playlist.title), ["First", "Second"]);
  assert.deepEqual(parsed.map((playlist) => playlist.tracks[0]?.url), [
    "https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA",
    "https://open.spotify.com/track/BBBBBBBBBBBBBBBBBBBBBB",
  ]);
});

test("Google Takeout ZIP accepts playlist CSV video IDs without invented metadata", () => {
  const archive = zipSync({
    "Takeout/YouTube and YouTube Music/playlists/Road.csv": strToU8("Video ID,Time Added\nabcdefghijk,2026-07-29T00:00:00Z\n"),
  });
  const [playlist] = parsePlaylistArchive({ provider: "youtube", fileName: "takeout.zip", data: archive });
  assert.equal(playlist.title, "Road");
  assert.equal(playlist.tracks[0]?.url, "https://www.youtube.com/watch?v=abcdefghijk");
  assert.equal(playlist.tracks[0]?.title, "Imported target 1");
});

test("archives with no supported playlist data fail closed", () => {
  const archive = zipSync({ "readme.html": strToU8("<p>Nothing to import</p>") });
  assert.throws(
    () => parsePlaylistArchive({ provider: "spotify", fileName: "empty.zip", data: archive }),
    /IMPORT_ARCHIVE_NO_SUPPORTED_PLAYLISTS/u,
  );
});
