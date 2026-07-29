export type Provider = "spotify" | "soundcloud" | "youtube";
export type ConnectorStrategy = "api" | "guided";

export type CapabilityValue = boolean | "unknown" | "external-gate";

export type ConnectorCapabilities = {
  canReadOwned: CapabilityValue;
  canReadCollaborative: CapabilityValue;
  canWriteOwned: CapabilityValue;
  canWriteCollaborative: CapabilityValue;
  canCreate: CapabilityValue;
  canBatchAdd: boolean;
  batchSize: number;
  canPreserveOrder: CapabilityValue;
  canSetCoverOnCreate: CapabilityValue;
  canSetCoverAfterCreate: CapabilityValue;
  canSeekToFraction: CapabilityValue;
  canEmbedAlongsideCompetitor: CapabilityValue;
  maxPlaylistItems?: number;
  supportsISRC: boolean;
  requiresWriteReauth: boolean;
  domRead: false;
  uiWrite: false;
};

export type ProviderEntityRef = {
  provider: Provider;
  entityKind: "playlist" | "track" | "video";
  providerEntityId?: string;
  providerUriOrUrl: string;
  videoId?: string;
  playlistId?: string;
  containsSecretUrl: boolean;
  redactedDisplayUrl: string;
  validationStatus:
    | "SYNTAX_CONFIRMED"
    | "USER_SELECTED_REAL_URL"
    | "PROVIDER_VALIDATED"
    | "USER_SELECTED_UNVERIFIED";
  fetchedAt?: number;
  titleRaw?: string;
  artistRaw?: string;
  durationMs?: number;
  /** True only when an official provider response supplied the embed status. */
  embeddable?: boolean;
  attributionUrl: string;
};

export type GuidedAction = {
  id: string;
  provider: Provider;
  kind: "OPEN_SEARCH" | "CREATE_PLAYLIST" | "ADD_ITEM" | "VERIFY_ITEM" | "WAIT_QUOTA_RESET";
  title: string;
  instructions: string[];
  openUrl?: string;
  searchQuery?: string;
  targetEntityId?: string;
  destinationLabel?: string;
  requiresFreshDestinationConfirmation?: boolean;
  expectedDestinationItemCount?: number;
  destinationSnapshotVersion?: string;
  baselineAmbiguous?: boolean;
  destinationBaselineKind?: "NEW_EMPTY_AT_BINDING" | "EXISTING_SNAPSHOT";
  confirmedPriorAdds?: number;
  expectedManualActions: number;
  automation: "USER_OPERATED";
};

export type ValidationResult = {
  ref: ProviderEntityRef;
  evidence: {
    method: "URL_SYNTAX" | "OFFICIAL_OEMBED" | "OFFICIAL_API";
    checkedAt: number;
    providerReadBack: boolean;
    semanticEqualityProven: false;
  };
  limitations: string[];
};

export interface ProviderConnector {
  readonly provider: Provider;
  readonly strategy: ConnectorStrategy;
  readonly capabilities: ConnectorCapabilities;
  parseUserUrl(url: string): ProviderEntityRef;
  buildSearchUrl(query: string): string;
  validateTargetEntity(ref: ProviderEntityRef): Promise<ValidationResult>;
  buildAddAction(ref: ProviderEntityRef, destination: { id?: string; url?: string; label: string }): GuidedAction;
}
