import { randomBytes } from "node:crypto";

export const LOCAL_ORIGIN = process.env.PLAYLIST_TRANSFER_ORIGIN ?? "http://127.0.0.1:3210";
export const SESSION_COOKIE = "playlist-transfer_session";

type LocalSession = {
  id: string;
  csrf: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  expiresAtMs: number;
};

declare global {
  var __playlistTransferSessions: Map<string, LocalSession> | undefined;
  var __playlistTransferRateLimits: Map<string, number[]> | undefined;
}

const sessions = globalThis.__playlistTransferSessions ?? new Map<string, LocalSession>();
globalThis.__playlistTransferSessions = sessions;
const rateLimits = globalThis.__playlistTransferRateLimits ?? new Map<string, number[]>();
globalThis.__playlistTransferRateLimits = rateLimits;

function token(bytes: number) {
  return randomBytes(bytes).toString("base64url");
}

export function assertLoopbackRequest(request: Request, options: { mutation?: boolean; allowMissingOrigin?: boolean } = {}) {
  const expected = new URL(LOCAL_ORIGIN);
  const actual = new URL(request.url);
  const host = request.headers.get("host");
  if (actual.protocol !== "http:") throw new Error("LOOPBACK_ONLY");
  if (host) {
    // Next.js may normalize Request.url to its internal localhost origin. The
    // HTTP Host header is the external authority the user actually reached.
    if (host !== expected.host) throw new Error("INVALID_HOST");
  } else if (actual.hostname !== expected.hostname || actual.port !== expected.port) {
    throw new Error("LOOPBACK_ONLY");
  }
  const origin = request.headers.get("origin");
  if (options.mutation && !origin && !options.allowMissingOrigin) throw new Error("ORIGIN_REQUIRED");
  if (origin && origin !== LOCAL_ORIGIN) throw new Error("INVALID_ORIGIN");
}

function readCookie(request: Request, name: string): string | undefined {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

export function createLocalSession(): LocalSession {
  const now = Date.now();
  const session: LocalSession = {
    id: token(32),
    csrf: token(32),
    createdAtMs: now,
    lastSeenAtMs: now,
    expiresAtMs: now + 4 * 60 * 60 * 1000,
  };
  sessions.set(session.id, session);
  return session;
}

export function resumeOrCreateLocalSession(request: Request): { session: LocalSession; created: boolean } {
  const id = readCookie(request, SESSION_COOKIE);
  const existing = id ? sessions.get(id) : undefined;
  if (existing && existing.expiresAtMs >= Date.now()) {
    existing.lastSeenAtMs = Date.now();
    return { session: existing, created: false };
  }
  if (id) sessions.delete(id);
  return { session: createLocalSession(), created: true };
}

export function requireLocalSession(request: Request): LocalSession {
  const id = readCookie(request, SESSION_COOKIE);
  const session = id ? sessions.get(id) : undefined;
  if (!session || session.expiresAtMs < Date.now()) {
    if (id) sessions.delete(id);
    throw new Error("LOCAL_SESSION_REQUIRED");
  }
  session.lastSeenAtMs = Date.now();
  return session;
}

export function requireCsrf(request: Request): LocalSession {
  assertLoopbackRequest(request, { mutation: true });
  const session = requireLocalSession(request);
  const presented = request.headers.get("x-playlist-transfer-csrf");
  if (!presented || presented !== session.csrf) throw new Error("CSRF_REJECTED");
  return session;
}

export function requireLocalRead(request: Request): LocalSession {
  assertLoopbackRequest(request);
  const session = requireLocalSession(request);
  if (request.headers.get("x-playlist-transfer-nonce") !== session.csrf) throw new Error("SESSION_NONCE_REJECTED");
  return session;
}

export function sessionCookie(session: LocalSession) {
  return `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=14400`;
}

export function clearSession(request: Request) {
  const id = readCookie(request, SESSION_COOKIE);
  if (id) sessions.delete(id);
}

export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const recent = (rateLimits.get(key) ?? []).filter((time) => time > now - windowMs);
  if (recent.length >= max) throw new Error("LOCAL_RATE_LIMITED");
  recent.push(now);
  rateLimits.set(key, recent);
}

export function publicSession(session: LocalSession) {
  return { csrf: session.csrf, expiresAtMs: session.expiresAtMs, origin: LOCAL_ORIGIN };
}
