export type Provider = "spotify" | "soundcloud" | "youtube";
export type TransferMode = "SEPARATE_COPY" | "MERGE_NEW" | "APPEND_EXISTING";

export type PlaylistSnapshot = {
  id: string;
  provider: Provider;
  providerPlaylistId?: string;
  providerUrl: string;
  title: string;
  description?: string;
  ownerLabel: string;
  eligibility: string;
  itemCount: number;
  partial: boolean;
  sourceVersion: string;
};

export type TransferRecord = {
  id: string;
  state: string;
  sourceProvider: Provider;
  destinationProvider: Provider;
  mode: TransferMode;
  settings: Record<string, unknown>;
  selectedPlaylistIds: string[];
  destination: Record<string, unknown>;
  writePlan?: Record<string, unknown>;
  limitationCodes: string[];
  errorCode?: string;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
};

export type ProviderTarget = {
  provider?: Provider;
  providerEntityId?: string;
  providerUriOrUrl?: string;
  redactedDisplayUrl?: string;
  attributionUrl?: string;
  titleRaw?: string;
  artistRaw?: string;
  uploaderRaw?: string;
  channelRaw?: string;
  durationMs?: number;
  videoId?: string;
  embeddable?: boolean;
};

export type ScoreEvidence = { signal?: string; points?: number; detail?: string };

export type CandidateProvenance = {
  source?: "PROVIDER_API" | "PROVIDER_OEMBED" | "URL_SYNTAX_ONLY";
  validationStatus?: string;
  exactIdParsed?: boolean;
  providerReadBack?: boolean;
  providerExistenceConfirmed?: boolean;
  metadataFields?: Array<"title" | "artist" | "duration" | "embeddable">;
  checkedAt?: string;
  limitations?: string[];
};

export type ReviewCandidate = {
  target?: ProviderTarget;
  candidate?: { target?: ProviderTarget; embeddable?: boolean; validation?: { status?: string } };
  validation?: { status?: string };
  provenance?: CandidateProvenance;
  score?: number;
  titleSimilarity?: number;
  artistSimilarity?: number | null;
  durationDeltaMs?: number | null;
  conflicts?: string[];
  evidence?: ScoreEvidence[];
  embeddable?: boolean;
  validationStatus?: string;
};

export type TransferItem = {
  id: string;
  transferId: string;
  sourcePlaylistId: string;
  sourcePosition: number;
  state: string;
  sourceRef: ProviderTarget;
  hypotheses?: unknown[];
  candidates?: ReviewCandidate[];
  decision?: Record<string, unknown>;
  selectedTarget?: ProviderTarget;
  idempotencyKey?: string;
  riskFlags?: string[];
  searchUrl?: string;
  updatedAtMs?: number;
};

export type Receipt = {
  id: string;
  transferItemId: string;
  destinationPlaylistId: string;
  targetEntityId: string;
  idempotencyKey: string;
  executionStatus: string;
  verificationStatus: "VERIFIED_PROVIDER" | "USER_CONFIRMED_MANUAL" | "WRITE_CONFIRMED_NON_OWNED" | "WRITE_UNVERIFIED" | string;
  evidence?: Record<string, unknown>;
  risky?: boolean;
  manual?: boolean;
  createdAtMs?: number;
};

export type GuidedAction = {
  actionId?: string;
  transferItemId?: string;
  provider?: Provider;
  targetEntityId?: string;
  videoId?: string;
  targetUrl?: string;
  officialUrl?: string;
  destinationPlaylistId?: string;
  destinationUrl?: string;
  title?: string;
  instructions?: string[];
  purpose?: string;
  requiresFreshDestinationConfirmation?: boolean;
  expectedDestinationItemCount?: number;
  destinationSnapshotVersion?: string;
  baselineAmbiguous?: boolean;
  destinationBaselineKind?: "NEW_EMPTY_AT_BINDING" | "EXISTING_SNAPSHOT";
  confirmedPriorAdds?: number;
};

export type TransferDetail = {
  transfer: TransferRecord;
  items: TransferItem[];
  receipts: Receipt[];
  journal: Array<Record<string, unknown>>;
  actionCard?: GuidedAction;
  progress?: {
    total?: number;
    resolved?: number;
    written?: number;
    verified?: number;
    manual?: number;
    unverified?: number;
    failed?: number;
    percent?: number;
  };
  bindingNeeds?: Array<{ planKey: string; title?: string; description?: string; privacy?: string; copyCover?: boolean; provider?: Provider; requiresNewEmptyDestination?: boolean; expectedVisibleItemCount?: 0 }>;
  externalGate?: { code?: string; status?: string; reason?: string; providerMutationPerformed?: boolean };
  capabilities?: { strategy?: string; domRead?: boolean; uiAutomation?: boolean; fullSideBySideComparison?: boolean; soundcloudTransfer?: string };
  report?: Record<string, unknown>;
};

export function normalizeTransferDetail(value: unknown): TransferDetail {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const transfer = ((raw.transfer && typeof raw.transfer === "object") ? raw.transfer : raw) as TransferRecord;
  return {
    transfer,
    items: Array.isArray(raw.items) ? raw.items as TransferItem[] : [],
    receipts: Array.isArray(raw.receipts) ? raw.receipts as Receipt[] : [],
    journal: Array.isArray(raw.journal) ? raw.journal as Array<Record<string, unknown>> : [],
    actionCard: (raw.actionCard ?? raw.pendingAction ?? raw.guidedAction) as GuidedAction | undefined,
    progress: raw.progress && typeof raw.progress === "object" ? raw.progress as TransferDetail["progress"] : undefined,
    bindingNeeds: Array.isArray(raw.bindingNeeds) ? raw.bindingNeeds as NonNullable<TransferDetail["bindingNeeds"]> : [],
    externalGate: raw.externalGate && typeof raw.externalGate === "object" ? raw.externalGate as TransferDetail["externalGate"] : undefined,
    capabilities: raw.capabilities && typeof raw.capabilities === "object" ? raw.capabilities as TransferDetail["capabilities"] : undefined,
    report: raw.report && typeof raw.report === "object" ? raw.report as Record<string, unknown> : undefined,
  };
}

export function candidateTarget(candidate: ReviewCandidate): ProviderTarget {
  return candidate.candidate?.target ?? candidate.target ?? {};
}

export function candidateEmbeddable(candidate: ReviewCandidate): boolean {
  return (candidate.candidate?.embeddable ?? candidate.embeddable ?? candidateTarget(candidate).embeddable) === true;
}

export function displayProvider(provider?: Provider): string {
  if (provider === "youtube") return "YouTube / Music";
  if (provider === "soundcloud") return "SoundCloud";
  return provider === "spotify" ? "Spotify" : "—";
}

export function honestBadge(status: string): "verified" | "manual" | "error" | "" {
  if (status === "VERIFIED_PROVIDER" || status === "API_VERIFIED_OWNED" || status === "COMPLETED") return "verified";
  if (status === "USER_CONFIRMED_MANUAL" || status.includes("ATTESTED") || status === "PARTIAL") return "manual";
  if (status.includes("UNVERIFIED") || status.includes("FAILED") || status === "CANCELLED") return "error";
  return "";
}

export function formatDuration(durationMs?: number, language: "ru" | "en" = "ru"): string {
  if (!Number.isFinite(durationMs)) return language === "ru" ? "длительность неизвестна" : "duration unknown";
  const seconds = Math.max(0, Math.round((durationMs ?? 0) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
