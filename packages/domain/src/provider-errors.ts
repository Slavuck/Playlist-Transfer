import type { Provider } from "./provider.js";

export type ProviderErrorCategory =
  | "AUTH_REQUIRED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "PROVIDER_UNAVAILABLE"
  | "AMBIGUOUS_NETWORK_RESULT"
  | "POLICY_BLOCKED"
  | "UNKNOWN";

export type RetryDirective =
  | "NEVER"
  | "REAUTHENTICATE"
  | "BACKOFF"
  | "WAIT_RETRY_AFTER"
  | "WAIT_QUOTA_RESET"
  | "VERIFY_BEFORE_RETRY";

export interface ProviderErrorInput {
  readonly provider: Provider;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly operation: "READ" | "SEARCH" | "CREATE" | "WRITE" | "VERIFY";
  readonly responseReceived: boolean;
  readonly retryAfterSeconds?: number;
}

export interface MappedProviderError {
  readonly provider: Provider;
  readonly category: ProviderErrorCategory;
  readonly retry: RetryDirective;
  readonly retryAfterSeconds?: number;
  readonly requiresReadVerification: boolean;
}

const QUOTA_CODES = new Set(["quotaexceeded", "dailylimitexceeded", "ratelimitexceeded-quota"]);
const AUTH_CODES = new Set(["invalid_grant", "invalid_token", "token_expired"]);

export function mapProviderError(input: ProviderErrorInput): MappedProviderError {
  const status = input.httpStatus;
  const code = input.providerCode?.trim().toLowerCase();
  const mutation = input.operation === "CREATE" || input.operation === "WRITE";

  if (!input.responseReceived) {
    return {
      provider: input.provider,
      category: mutation ? "AMBIGUOUS_NETWORK_RESULT" : "PROVIDER_UNAVAILABLE",
      retry: mutation ? "VERIFY_BEFORE_RETRY" : "BACKOFF",
      requiresReadVerification: mutation,
    };
  }
  if (code && AUTH_CODES.has(code)) {
    return { provider: input.provider, category: "AUTH_REQUIRED", retry: "REAUTHENTICATE", requiresReadVerification: false };
  }
  if (code && QUOTA_CODES.has(code)) {
    return { provider: input.provider, category: "QUOTA_EXHAUSTED", retry: "WAIT_QUOTA_RESET", requiresReadVerification: false };
  }
  if (status === 401) {
    return { provider: input.provider, category: "AUTH_REQUIRED", retry: "REAUTHENTICATE", requiresReadVerification: false };
  }
  if (status === 403) {
    return { provider: input.provider, category: "PERMISSION_DENIED", retry: "NEVER", requiresReadVerification: false };
  }
  if (status === 404) {
    return { provider: input.provider, category: "NOT_FOUND", retry: "NEVER", requiresReadVerification: false };
  }
  if (status === 429) {
    return {
      provider: input.provider,
      category: "RATE_LIMITED",
      retry: "WAIT_RETRY_AFTER",
      retryAfterSeconds: input.retryAfterSeconds,
      requiresReadVerification: false,
    };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { provider: input.provider, category: "INVALID_REQUEST", retry: "NEVER", requiresReadVerification: false };
  }
  if (status !== undefined && status >= 500) {
    return {
      provider: input.provider,
      category: "PROVIDER_UNAVAILABLE",
      retry: mutation ? "VERIFY_BEFORE_RETRY" : "BACKOFF",
      requiresReadVerification: mutation,
    };
  }
  return { provider: input.provider, category: "UNKNOWN", retry: "NEVER", requiresReadVerification: false };
}
