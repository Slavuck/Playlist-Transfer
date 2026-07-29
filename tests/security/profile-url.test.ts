import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOfficialProfileUrl } from "../../app/api/connections/profile-url";

test("accepts and canonicalizes exact provider account profile paths", () => {
  assert.equal(normalizeOfficialProfileUrl("spotify", "https://open.spotify.com/user/alice/"), "https://open.spotify.com/user/alice");
  assert.equal(normalizeOfficialProfileUrl("soundcloud", "https://www.soundcloud.com/alice/"), "https://soundcloud.com/alice");
  assert.equal(normalizeOfficialProfileUrl("youtube", "https://youtube.com/@alice/"), "https://www.youtube.com/@alice");
  assert.equal(normalizeOfficialProfileUrl("youtube", "https://music.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa"), "https://music.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa");
});

test("rejects secrets, non-profile pages, nested content and lookalike hosts", () => {
  const invalid: Array<["spotify" | "soundcloud" | "youtube", string]> = [
    ["spotify", "https://open.spotify.com/user/alice?si=secret"],
    ["spotify", "https://open.spotify.com/playlist/abc"],
    ["soundcloud", "https://soundcloud.com/alice/private-track"],
    ["soundcloud", "https://soundcloud.com/search"],
    ["youtube", "https://www.youtube.com/watch?v=abcdefghijk"],
    ["youtube", "https://youtube.com.evil.example/@alice"],
    ["youtube", "https://user:pass@youtube.com/@alice"],
    ["youtube", "https://youtube.com:444/@alice"],
    ["youtube", "https://youtube.com/@alice#fragment"],
  ];
  for (const [provider, url] of invalid) {
    assert.throws(() => normalizeOfficialProfileUrl(provider, url), /OFFICIAL_PROVIDER_PROFILE_URL_REQUIRED/);
  }
});
