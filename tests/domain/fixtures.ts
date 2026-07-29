import {
  createProviderValidation,
  type CandidateValidation,
  type ProviderEntityValidationEvidence,
  type ProviderTrackReference,
} from "../../packages/domain/src/index.js";

export function spotifyTarget(overrides: Partial<ProviderTrackReference> = {}): ProviderTrackReference {
  return {
    provider: "spotify",
    entityKind: "track",
    providerEntityId: "4uLU6hMCjMI75M1A2tKUQC",
    providerUriOrUrl: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
    containsSecretUrl: false,
    redactedDisplayUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
    titleRaw: "Never Gonna Give You Up",
    artistRaw: "Rick Astley",
    durationMs: 213_000,
    isrc: "GBARL9300135",
    availability: "AVAILABLE",
    attributionUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
    fetchedAt: "2026-07-29T10:00:00.000Z",
    ...overrides,
  };
}

export function youtubeTarget(overrides: Partial<ProviderTrackReference> = {}): ProviderTrackReference {
  return {
    provider: "youtube",
    entityKind: "video",
    providerEntityId: "dQw4w9WgXcQ",
    videoId: "dQw4w9WgXcQ",
    providerUriOrUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    containsSecretUrl: false,
    redactedDisplayUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    titleRaw: "Never Gonna Give You Up",
    channelRaw: "Rick Astley",
    durationMs: 213_000,
    availability: "AVAILABLE",
    attributionUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    fetchedAt: "2026-07-29T10:00:00.000Z",
    ...overrides,
  };
}

export function providerValidation(target: ProviderTrackReference): CandidateValidation & { readonly status: "PROVIDER_VALIDATED" } {
  const evidence: ProviderEntityValidationEvidence = {
    kind: "PROVIDER_API",
    provider: target.provider,
    providerEntityId: target.providerEntityId,
    checkedAt: "2026-07-29T10:01:00.000Z",
    exists: true,
    evidenceVersion: "fixture-v1",
  };
  return createProviderValidation(target, evidence);
}
