import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getLocalDatabase } from "../../packages/storage-local/src/database";
import { getLocalVault } from "../../packages/storage-local/src/vault";

export function requireUnlockedProfile(): void {
  if (!getLocalDatabase().getProfile()) throw new Error("PROFILE_REQUIRED");
  if (!getLocalVault().isUnlocked) throw new Error("VAULT_LOCKED");
}

export function apiError(error: unknown) {
  const code = error instanceof ZodError ? "INVALID_INPUT" : error instanceof Error ? error.message : "UNKNOWN_ERROR";
  const status =
    code === "LOCAL_SESSION_REQUIRED" ? 401
      : code === "VAULT_LOCKED" || code === "PROFILE_REQUIRED" ? 423
      : code === "CSRF_REJECTED" || code === "SESSION_NONCE_REJECTED" || code === "ORIGIN_REQUIRED" || code === "INVALID_ORIGIN" || code === "INVALID_HOST" || code === "LOOPBACK_ONLY" ? 403
        : code === "YOUTUBE_API_POLICY_GATE_CLOSED" || code === "SPOTAPI_POLICY_GATE_CLOSED" ? 403
          : code === "YOUTUBE_REAUTH_REQUIRED" || code === "SPOTAPI_SESSION_EXPIRED" ? 401
          : code === "LOCAL_RATE_LIMITED" ? 429
            : code === "YOUTUBE_REVOKE_FAILED_MANUAL_REVOCATION_REQUIRED" ? 503
          : code === "TRANSFER_BUSY" || code === "DESTINATION_BUSY" || code === "ACTIVE_PROVIDER_OPERATION" ? 409
          : code.includes("NOT_FOUND") ? 404
            : 400;
  return NextResponse.json({ ok: false, error: { code, retryable: status >= 500 || status === 429 || status === 409 } }, { status });
}

export function apiOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}
