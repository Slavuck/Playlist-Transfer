import assert from "node:assert/strict";
import test from "node:test";
import { YoutubeApiClient, parseIsoDuration, youtubeQuotaPeriodKey } from "../../packages/connectors/youtube/src/client";
import { parseYoutubeUrl } from "../../packages/connectors-core/src/url-policy";
import { createYoutubeAuthorizationRequest, revokeYoutubeToken } from "../../packages/connectors/youtube/src/oauth";

const credentials = {
  clientId: "desktop-client.apps.googleusercontent.com",
  accessToken: "test-token",
  refreshToken: "refresh",
  expiresAtMs: Date.now() + 3_600_000,
  scopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
  tokenType: "Bearer" as const,
};

test("OAuth request uses PKCE S256, state and literal loopback callback", () => {
  const request = createYoutubeAuthorizationRequest({
    clientId: credentials.clientId,
    redirectUri: "http://127.0.0.1:3210/api/oauth/youtube/callback",
    write: true,
  });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), request.state);
  assert.match(url.searchParams.get("scope") ?? "", /youtube\.force-ssl/);
  assert.equal(request.verifier.length >= 43, true);
});

test("ISO duration enrichment is deterministic", () => {
  assert.equal(parseIsoDuration("PT3M30S"), 210_000);
  assert.equal(parseIsoDuration("PT1H2M3.5S"), 3_723_500);
  assert.equal(parseIsoDuration(undefined), undefined);
});

test("search candidates always expose the concrete videoId", async () => {
  const responses = [
    { items: [{ id: { videoId: "abcdefghijk" } }] },
    { items: [{ id: "abcdefghijk", snippet: { title: "Song", channelTitle: "Artist" }, contentDetails: { duration: "PT3M" }, status: { embeddable: true } }] },
  ];
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
  const client = new YoutubeApiClient(credentials, { fetchImpl, quotaUse: () => true });
  const candidates = await client.searchCandidates("Artist Song");
  assert.equal(candidates[0]?.videoId, "abcdefghijk");
  assert.equal(candidates[0]?.providerEntityId, "abcdefghijk");
  assert.equal(candidates[0]?.validationStatus, "PROVIDER_VALIDATED");
});

test("exact videos.list validation exposes official duration and embed status", async () => {
  const buckets: string[] = [];
  const client = new YoutubeApiClient(credentials, {
    fetchImpl: async () => new Response(JSON.stringify({
      items: [{
        id: "abcdefghijk",
        snippet: { title: "Provider title", channelTitle: "Provider channel" },
        contentDetails: { duration: "PT4M" },
        status: { embeddable: true },
      }],
    }), { status: 200 }),
    quotaUse: (bucket) => { buckets.push(bucket); return true; },
  });
  const result = await client.validateTargetEntity(parseYoutubeUrl("https://youtu.be/abcdefghijk"));
  assert.equal(result.evidence.method, "OFFICIAL_API");
  assert.equal(result.evidence.providerReadBack, true);
  assert.equal(result.ref.titleRaw, "Provider title");
  assert.equal(result.ref.artistRaw, "Provider channel");
  assert.equal(result.ref.durationMs, 240_000);
  assert.equal(result.ref.embeddable, true);
  assert.deepEqual(buckets, ["general"]);
});

test("search quota exhaustion stops before network access and waits honestly", async () => {
  let called = false;
  const client = new YoutubeApiClient(credentials, {
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
    quotaUse: (bucket) => bucket !== "search",
  });
  await assert.rejects(() => client.searchCandidates("Song"), /YOUTUBE_SEARCH_QUOTA_WAIT/);
  assert.equal(called, false);
});

test("quota day follows Pacific Time across standard and daylight-saving offsets", () => {
  assert.equal(youtubeQuotaPeriodKey(new Date("2026-01-01T07:59:59Z")), "2025-12-31");
  assert.equal(youtubeQuotaPeriodKey(new Date("2026-01-01T08:00:00Z")), "2026-01-01");
  assert.equal(youtubeQuotaPeriodKey(new Date("2026-07-29T06:59:59Z")), "2026-07-28");
  assert.equal(youtubeQuotaPeriodKey(new Date("2026-07-29T07:00:00Z")), "2026-07-29");
});

test("append rejects a missing or malformed videoId before API mutation", async () => {
  const client = new YoutubeApiClient(credentials, { fetchImpl: async () => new Response("{}", { status: 200 }), quotaUse: () => true });
  await assert.rejects(() => client.appendItem("PL1234567890", "short"), /YOUTUBE_VIDEO_ID_REQUIRED/);
});

test("expired credentials signal reauthorization before consuming quota or network", async () => {
  let reauth = 0;
  let quota = 0;
  let network = 0;
  const client = new YoutubeApiClient({ ...credentials, refreshToken: undefined, expiresAtMs: 0 }, {
    fetchImpl: async () => { network += 1; return new Response("{}"); },
    quotaUse: () => { quota += 1; return true; },
    onReauthRequired: () => { reauth += 1; },
  });
  await assert.rejects(() => client.verifyPlaylist("PL123", []), /YOUTUBE_REAUTH_REQUIRED/);
  assert.equal(reauth, 1);
  assert.equal(quota, 0);
  assert.equal(network, 0);
});

test("HTTP 429 maps to the honest quota-wait status", async () => {
  const client = new YoutubeApiClient(credentials, {
    fetchImpl: async () => new Response(JSON.stringify({ error: "rate" }), { status: 429 }),
    quotaUse: () => true,
  });
  await assert.rejects(() => client.verifyPlaylist("PL123", []), /YOUTUBE_QUOTA_WAIT/);
});

test("granular search quota does not also debit the general bucket", async () => {
  const buckets: string[] = [];
  const client = new YoutubeApiClient(credentials, {
    fetchImpl: async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    quotaUse: (bucket) => { buckets.push(bucket); return true; },
  });
  assert.deepEqual(await client.searchCandidates("nothing"), []);
  assert.deepEqual(buckets, ["search"]);
});

test("Google revocation uses the documented endpoint and accepts already-invalid tokens", async () => {
  let requested = "";
  await revokeYoutubeToken({
    token: "refresh-token",
    fetchImpl: async (input, init) => {
      requested = String(input);
      assert.match(String(init?.body), /token=refresh-token/);
      return new Response(JSON.stringify({ error: "invalid_token" }), { status: 400 });
    },
  });
  assert.equal(requested, "https://oauth2.googleapis.com/revoke");
});
