export type GuidedCaptureProvider = "spotify" | "soundcloud" | "youtube";

export type GuidedCapture = {
  schemaVersion: 1;
  provider: GuidedCaptureProvider;
  resourceKind: string;
  redactedDisplayUrl: string;
  canonicalUrl: string;
  containsSecret: false;
  capturedAtMs?: number;
};

export type GuidedCaptureDraft = {
  schemaVersion: 1;
  captures: GuidedCapture[];
  updatedAtMs: number;
};

export const GUIDED_CAPTURE_DRAFT_KEY = "playlist-transfer-guided-capture-draft-v1";
export const LEGACY_GUIDED_CAPTURE_KEY = "playlist-transfer-guided-capture-v1";

const MAX_CAPTURES = 500;
const MAX_URL_LENGTH = 4_096;
const PROVIDER_HOSTS: Record<GuidedCaptureProvider, ReadonlySet<string>> = {
  spotify: new Set(["open.spotify.com"]),
  soundcloud: new Set(["soundcloud.com", "www.soundcloud.com"]),
  youtube: new Set(["youtube.com", "www.youtube.com", "music.youtube.com", "m.youtube.com", "youtu.be"]),
};

type StorageTarget = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function safePublicUrl(provider: GuidedCaptureProvider, raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !PROVIDER_HOSTS[provider].has(url.hostname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function normalizeCapture(raw: unknown): GuidedCapture | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.containsSecret !== false) return undefined;
  const provider = value.provider;
  if (provider !== "spotify" && provider !== "soundcloud" && provider !== "youtube") return undefined;
  if (typeof value.resourceKind !== "string" || value.resourceKind.length === 0 || value.resourceKind.length > 32) return undefined;
  const canonicalUrl = safePublicUrl(provider, value.canonicalUrl);
  const redactedDisplayUrl = safePublicUrl(provider, value.redactedDisplayUrl);
  if (!canonicalUrl || !redactedDisplayUrl) return undefined;
  return {
    schemaVersion: 1,
    provider,
    resourceKind: value.resourceKind,
    canonicalUrl,
    redactedDisplayUrl,
    containsSecret: false,
    ...(typeof value.capturedAtMs === "number" && Number.isSafeInteger(value.capturedAtMs) && value.capturedAtMs > 0
      ? { capturedAtMs: value.capturedAtMs }
      : {}),
  };
}

function captureKey(capture: GuidedCapture): string {
  return `${capture.provider}\u0000${capture.resourceKind}\u0000${capture.canonicalUrl}`;
}

export function readGuidedCaptureDraft(storage: StorageTarget): GuidedCaptureDraft {
  try {
    const raw = storage.getItem(GUIDED_CAPTURE_DRAFT_KEY);
    if (!raw) return { schemaVersion: 1, captures: [], updatedAtMs: 0 };
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown; captures?: unknown; updatedAtMs?: unknown };
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.captures)) throw new Error("INVALID_CAPTURE_DRAFT");
    const captures = parsed.captures.flatMap((entry) => {
      const capture = normalizeCapture(entry);
      return capture ? [capture] : [];
    }).slice(-MAX_CAPTURES);
    return {
      schemaVersion: 1,
      captures,
      updatedAtMs: typeof parsed.updatedAtMs === "number" && Number.isSafeInteger(parsed.updatedAtMs) ? parsed.updatedAtMs : 0,
    };
  } catch {
    storage.removeItem(GUIDED_CAPTURE_DRAFT_KEY);
    return { schemaVersion: 1, captures: [], updatedAtMs: 0 };
  }
}

function writeGuidedCaptureDraft(storage: StorageTarget, captures: GuidedCapture[]): GuidedCaptureDraft {
  const draft: GuidedCaptureDraft = { schemaVersion: 1, captures: captures.slice(-MAX_CAPTURES), updatedAtMs: Date.now() };
  if (draft.captures.length === 0) storage.removeItem(GUIDED_CAPTURE_DRAFT_KEY);
  else storage.setItem(GUIDED_CAPTURE_DRAFT_KEY, JSON.stringify(draft));
  return draft;
}

export function appendGuidedCapture(storage: StorageTarget, rawCapture: unknown): GuidedCaptureDraft {
  const capture = normalizeCapture(rawCapture);
  if (!capture) throw new Error("PUBLIC_GUIDED_CAPTURE_REQUIRED");
  const draft = readGuidedCaptureDraft(storage);
  const key = captureKey(capture);
  const captures = draft.captures.filter((entry) => captureKey(entry) !== key);
  captures.push(capture);
  return writeGuidedCaptureDraft(storage, captures);
}

export function removeGuidedCaptures(
  storage: StorageTarget,
  predicate: (capture: GuidedCapture) => boolean,
): GuidedCaptureDraft {
  const draft = readGuidedCaptureDraft(storage);
  return writeGuidedCaptureDraft(storage, draft.captures.filter((capture) => !predicate(capture)));
}

export function clearGuidedCaptureDraft(storage: StorageTarget): void {
  storage.removeItem(GUIDED_CAPTURE_DRAFT_KEY);
}

export function migrateLegacyGuidedCapture(sessionStorage: StorageTarget, localStorage: StorageTarget): GuidedCaptureDraft {
  const legacy = sessionStorage.getItem(LEGACY_GUIDED_CAPTURE_KEY);
  sessionStorage.removeItem(LEGACY_GUIDED_CAPTURE_KEY);
  if (!legacy) return readGuidedCaptureDraft(localStorage);
  try {
    return appendGuidedCapture(localStorage, JSON.parse(legacy));
  } catch {
    return readGuidedCaptureDraft(localStorage);
  }
}
