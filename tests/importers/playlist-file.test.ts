import assert from "node:assert/strict";
import test from "node:test";
import { parsePlaylistFile } from "../../packages/importers/src/playlist-file.js";

test("Spotify account export imports a whole playlist without per-track typing", () => {
  const parsed = parsePlaylistFile({
    provider: "spotify",
    fileName: "Playlist1.json",
    content: JSON.stringify({
      playlists: [{
        name: "Thousand-track library",
        uri: "spotify:playlist:1234567890123456789012",
        items: [
          { track: { trackName: "First", artistName: "Artist A", trackUri: "spotify:track:AAAAAAAAAAAAAAAAAAAAAA" } },
          { track: { trackName: "Second", artistName: "Artist B", trackUri: "spotify:track:BBBBBBBBBBBBBBBBBBBBBB" } },
        ],
      }],
    }),
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, "Thousand-track library");
  assert.equal(parsed[0].playlistUrl, "https://open.spotify.com/playlist/1234567890123456789012");
  assert.deepEqual(parsed[0].tracks.map((track) => track.url), [
    "https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA",
    "https://open.spotify.com/track/BBBBBBBBBBBBBBBBBBBBBB",
  ]);
});

test("CSV parser accepts quoted metadata and preserves duplicate positions", () => {
  const parsed = parsePlaylistFile({
    provider: "youtube",
    fileName: "videos.csv",
    content: [
      "playlist_title,playlist_url,track_title,artist,duration_seconds,track_url",
      '"Road, long","https://www.youtube.com/playlist?list=PL1234567890","One","Channel",123,"https://youtu.be/abcdefghijk"',
      '"Road, long","https://www.youtube.com/playlist?list=PL1234567890","One","Channel",123,"https://youtu.be/abcdefghijk"',
    ].join("\n"),
  });
  assert.equal(parsed[0].title, "Road, long");
  assert.equal(parsed[0].tracks.length, 2);
  assert.equal(parsed[0].sourceItemCount, 2);
  assert.equal(parsed[0].tracks[0].durationSeconds, 123);
  assert.equal(parsed[0].tracks[1].url, parsed[0].tracks[0].url);
});

test("M3U parser imports every URL and EXTINF metadata", () => {
  const parsed = parsePlaylistFile({
    provider: "soundcloud",
    fileName: "set.m3u8",
    content: "#EXTM3U\n#PLAYLIST:My set\n#EXTINF:210,Artist - Track\nhttps://soundcloud.com/artist/track\n",
  });
  assert.equal(parsed[0].title, "My set");
  assert.deepEqual(parsed[0].tracks[0], {
    title: "Track",
    artist: "Artist",
    durationSeconds: 210,
    url: "https://soundcloud.com/artist/track",
    unavailable: false,
  });
});

test("plain URL lists are accepted with neutral metadata instead of invented titles", () => {
  const parsed = parsePlaylistFile({
    provider: "spotify",
    fileName: "targets.txt",
    content: "spotify:track:CCCCCCCCCCCCCCCCCCCCCC\nspotify:track:DDDDDDDDDDDDDDDDDDDDDD",
  });
  assert.equal(parsed[0].tracks.length, 2);
  assert.equal(parsed[0].tracks[0].title, "Imported target 1");
  assert.equal(parsed[0].tracks[0].artist, "");
});

test("empty and URL-free imports fail closed", () => {
  assert.throws(() => parsePlaylistFile({ provider: "spotify", fileName: "empty.txt", content: "   " }), /IMPORT_FILE_EMPTY/u);
  assert.throws(() => parsePlaylistFile({ provider: "spotify", fileName: "bad.csv", content: "title,url\nNope,not-a-url" }), /IMPORT_NO_VALID_TRACKS/u);
});

test("invalid rows keep the snapshot count partial instead of claiming completeness", () => {
  const parsed = parsePlaylistFile({
    provider: "spotify",
    fileName: "mixed.txt",
    content: "spotify:track:EEEEEEEEEEEEEEEEEEEEEE\nnot-a-provider-url",
  });
  assert.equal(parsed[0].tracks.length, 1);
  assert.equal(parsed[0].sourceItemCount, 2);
  assert.deepEqual(parsed[0].warnings, ["ROWS_WITHOUT_VALID_TRACK_URL_SKIPPED:1"]);
});
