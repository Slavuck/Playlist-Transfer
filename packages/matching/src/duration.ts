export interface DurationWindows {
  readonly safeMs: number;
  readonly reviewMs: number;
}

export type DurationBand = "UNKNOWN" | "SAFE" | "REVIEW" | "OUTSIDE_REVIEW" | "VERSION_EXPLAINED";

export interface DurationComparison {
  readonly band: DurationBand;
  readonly deltaMs: number | null;
  readonly safeWindowMs: number | null;
  readonly reviewWindowMs: number | null;
  readonly safeHardBlock: boolean;
  readonly riskyWarning: boolean;
}

export function durationWindows(sourceDurationMs: number): DurationWindows {
  if (!Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) {
    throw new RangeError("Source duration must be a positive finite number");
  }
  return {
    safeMs: Math.max(4_000, sourceDurationMs * 0.03),
    reviewMs: Math.max(12_000, sourceDurationMs * 0.1),
  };
}

export function compareDuration(
  sourceDurationMs: number | undefined,
  candidateDurationMs: number | undefined,
  versionExplainsDifference = false,
): DurationComparison {
  if (
    sourceDurationMs === undefined ||
    candidateDurationMs === undefined ||
    !Number.isFinite(sourceDurationMs) ||
    !Number.isFinite(candidateDurationMs) ||
    sourceDurationMs <= 0 ||
    candidateDurationMs <= 0
  ) {
    return {
      band: "UNKNOWN",
      deltaMs: null,
      safeWindowMs: null,
      reviewWindowMs: null,
      safeHardBlock: false,
      riskyWarning: false,
    };
  }

  const windows = durationWindows(sourceDurationMs);
  const deltaMs = Math.abs(sourceDurationMs - candidateDurationMs);
  if (deltaMs <= windows.safeMs) {
    return { band: "SAFE", deltaMs, safeWindowMs: windows.safeMs, reviewWindowMs: windows.reviewMs, safeHardBlock: false, riskyWarning: false };
  }
  if (deltaMs <= windows.reviewMs) {
    return { band: "REVIEW", deltaMs, safeWindowMs: windows.safeMs, reviewWindowMs: windows.reviewMs, safeHardBlock: false, riskyWarning: true };
  }
  if (versionExplainsDifference) {
    return { band: "VERSION_EXPLAINED", deltaMs, safeWindowMs: windows.safeMs, reviewWindowMs: windows.reviewMs, safeHardBlock: false, riskyWarning: true };
  }
  return { band: "OUTSIDE_REVIEW", deltaMs, safeWindowMs: windows.safeMs, reviewWindowMs: windows.reviewMs, safeHardBlock: true, riskyWarning: true };
}
