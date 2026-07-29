import type { ProviderEntityRef, ValidationResult } from "./types";

type OEmbedPayload = {
  title?: string;
  author_name?: string;
  provider_name?: string;
};

function endpointFor(ref: ProviderEntityRef): URL {
  if (ref.provider === "spotify") {
    const endpoint = new URL("https://open.spotify.com/oembed");
    endpoint.searchParams.set("url", ref.providerUriOrUrl);
    return endpoint;
  }
  if (ref.provider === "soundcloud") {
    const endpoint = new URL("https://soundcloud.com/oembed");
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("url", ref.providerUriOrUrl);
    return endpoint;
  }
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("url", ref.providerUriOrUrl);
  return endpoint;
}

export async function validateWithOfficialOEmbed(ref: ProviderEntityRef): Promise<ValidationResult> {
  const endpoint = endpointFor(ref);
  const allowed = new Set(["open.spotify.com", "soundcloud.com", "www.youtube.com"]);
  if (endpoint.protocol !== "https:" || !allowed.has(endpoint.hostname)) throw new Error("OEMBED_SSRF_BLOCKED");
  const response = await fetch(endpoint, {
    headers: { Accept: "application/json", "User-Agent": "Playlist-Transfer/1.0 local-personal-tool" },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`OEMBED_${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > 256_000) throw new Error("OEMBED_RESPONSE_TOO_LARGE");
  const text = await response.text();
  if (text.length > 256_000) throw new Error("OEMBED_RESPONSE_TOO_LARGE");
  const payload = JSON.parse(text) as OEmbedPayload;
  const checkedAt = Date.now();
  return {
    ref: {
      ...ref,
      titleRaw: payload.title,
      artistRaw: payload.author_name,
      validationStatus: "PROVIDER_VALIDATED",
      fetchedAt: checkedAt,
    },
    evidence: {
      method: "OFFICIAL_OEMBED",
      checkedAt,
      providerReadBack: true,
      semanticEqualityProven: false,
    },
    limitations:
      ref.provider === "soundcloud"
        ? ["OEMBED_NO_STRUCTURED_DURATION", "OEMBED_NO_STABLE_URN", "OWNERSHIP_NOT_VERIFIED"]
        : ["OWNERSHIP_NOT_VERIFIED", "WRITE_ACCESS_NOT_VERIFIED"],
  };
}
