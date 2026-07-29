import { NextResponse } from "next/server";
import { apiError } from "../_shared";
import {
  assertLoopbackRequest,
  createLocalSession,
  publicSession,
  rateLimit,
  sessionCookie,
} from "../../../packages/security/src/loopback-session";
import { getLocalDatabase } from "../../../packages/storage-local/src/database";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    assertLoopbackRequest(request);
    rateLimit("session", 30, 60_000);
    getLocalDatabase().cleanupExpired();
    const session = createLocalSession();
    const response = NextResponse.json({ ok: true, data: publicSession(session) });
    response.headers.set("Set-Cookie", sessionCookie(session));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return apiError(error);
  }
}
