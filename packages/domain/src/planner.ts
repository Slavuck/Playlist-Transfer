import type { PlaylistEligibilityStatus } from "./eligibility.js";
import { assertCandidateValidation, type CandidateValidation } from "./evidence.js";
import {
  assertProviderTrackReference,
  type Provider,
  type ProviderTrackReference,
} from "./provider.js";
import type { TransferMode } from "./contracts.js";
import type { TransferSettings } from "./settings.js";
import { validateTransferSettings } from "./settings.js";

export type MatchSelectionKind =
  | "MATCHED_AUTO"
  | "USER_SELECTED"
  | "RISKY_MATCH"
  | "RISKY_RELEVANCE_FALLBACK";

export interface SelectedSourceItem {
  readonly sourceItemId: string;
  readonly sourcePosition: number;
  readonly target: ProviderTrackReference;
  readonly validation: CandidateValidation;
  readonly selectionKind: MatchSelectionKind;
  readonly writeStrategy: "API" | "GUIDED_USER_ACTION";
  readonly confirmedEquivalenceKey?: string;
}

export interface PlannerSourcePlaylist {
  readonly sourcePlaylistId: string;
  readonly title: string;
  readonly description?: string;
  readonly privacy?: string;
  readonly selectedItems: readonly SelectedSourceItem[];
}

export interface DestinationMetadataPlan {
  readonly title: string;
  readonly description?: string;
  readonly privacy?: string;
  readonly copyCover: boolean;
}

export interface ExistingDestinationPlan {
  readonly providerPlaylistId: string;
  readonly title: string;
  readonly eligibility: PlaylistEligibilityStatus;
  readonly existingProviderEntityIds: readonly string[];
  readonly currentItemCount: number;
}

interface PlannerBaseInput {
  readonly transferId: string;
  readonly destinationProvider: Provider;
  readonly sources: readonly PlannerSourcePlaylist[];
  readonly settings: TransferSettings;
  readonly destinationMaxItems?: number | null;
}

export type TransferPlannerInput = PlannerBaseInput &
  (
    | { readonly mode: "SEPARATE_COPY" }
    | { readonly mode: "MERGE_NEW"; readonly mergedMetadata: Omit<DestinationMetadataPlan, "copyCover"> }
    | { readonly mode: "APPEND_EXISTING"; readonly existingDestination: ExistingDestinationPlan }
  );

export interface BlueprintItem extends SelectedSourceItem {
  readonly sourcePlaylistId: string;
}

export interface DestinationBlueprint {
  readonly destinationPlanKey: string;
  readonly existingProviderPlaylistId?: string;
  readonly sourcePlaylistIds: readonly string[];
  readonly metadata: DestinationMetadataPlan;
  readonly items: readonly BlueprintItem[];
  readonly partNumber?: number;
  readonly partCount?: number;
}

export interface TransferBlueprint {
  readonly transferId: string;
  readonly mode: TransferMode;
  readonly destinationProvider: Provider;
  readonly settings: TransferSettings;
  readonly destinations: readonly DestinationBlueprint[];
  readonly orderGuaranteed: boolean;
  readonly omittedDuplicateCount: number;
}

export interface PlannedWriteItem extends BlueprintItem {
  readonly destinationPlaylistId: string;
  readonly destinationOrdinal: number;
  readonly idempotencyKey: string;
}

export interface WritePlanDestination extends DestinationBlueprint {
  readonly destinationPlaylistId: string;
  readonly items: readonly PlannedWriteItem[];
}

export interface ImmutableWritePlan {
  readonly transferId: string;
  readonly mode: TransferMode;
  readonly destinationProvider: Provider;
  readonly destinations: readonly WritePlanDestination[];
  readonly expectedItemWrites: number;
  readonly expectedPlaylistCreates: number;
  readonly orderGuaranteed: boolean;
  readonly omittedDuplicateCount: number;
}

function requiredText(value: string, name: string): string {
  const result = value.trim();
  if (!result) throw new TypeError(`${name} is required`);
  return result;
}

function assertSelectedItem(
  item: SelectedSourceItem,
  destinationProvider: Provider,
): void {
  requiredText(item.sourceItemId, "sourceItemId");
  if (!Number.isSafeInteger(item.sourcePosition) || item.sourcePosition < 0) {
    throw new RangeError("sourcePosition must be a non-negative integer");
  }
  assertProviderTrackReference(item.target);
  assertCandidateValidation(item.target, item.validation);
  if (item.target.provider !== destinationProvider) {
    throw new Error("Selected target provider does not match destination provider");
  }
  if (item.validation.status === "INVALID" || item.validation.status === "UNVALIDATED") {
    throw new Error("A write plan cannot contain an invalid or unvalidated target");
  }
  if (item.writeStrategy === "API" && item.validation.status !== "PROVIDER_VALIDATED") {
    throw new Error("API writes require a provider-validated target entity");
  }
}

function lengthPrefixed(value: string | number): string {
  const text = String(value);
  return `${text.length}:${text}`;
}

/** Collision-free canonical tuple; source position intentionally remains part of the key. */
export function createItemIdempotencyKey(input: {
  readonly transferId: string;
  readonly destinationPlaylistId: string;
  readonly sourcePlaylistId: string;
  readonly sourcePosition: number;
  readonly selectedTargetId: string;
}): string {
  if (!Number.isSafeInteger(input.sourcePosition) || input.sourcePosition < 0) {
    throw new RangeError("sourcePosition must be a non-negative integer");
  }
  const parts = [
    requiredText(input.transferId, "transferId"),
    requiredText(input.destinationPlaylistId, "destinationPlaylistId"),
    requiredText(input.sourcePlaylistId, "sourcePlaylistId"),
    input.sourcePosition,
    requiredText(input.selectedTargetId, "selectedTargetId"),
  ];
  return `transfer-item:v1:${parts.map(lengthPrefixed).join("|")}`;
}

function itemDedupeKey(item: BlueprintItem, policy: TransferSettings["dedupe"]): string | null {
  if (policy === "NONE") return null;
  const providerId = `${item.target.provider}:${item.target.providerEntityId}`;
  if (policy === "TARGET_ID") return providerId;
  return item.confirmedEquivalenceKey?.trim()
    ? `equivalence:${item.confirmedEquivalenceKey.trim()}`
    : `confirmed-target:${providerId}`;
}

function dedupeItems(
  items: readonly BlueprintItem[],
  settings: TransferSettings,
  existingProviderEntityIds: readonly string[] = [],
): { readonly items: readonly BlueprintItem[]; readonly omitted: number } {
  const effectivePolicy = settings.dedupe === "NONE" && !settings.preserveDuplicates ? "TARGET_ID" : settings.dedupe;
  if (effectivePolicy === "NONE") return { items: [...items], omitted: 0 };
  const seen = new Set<string>();
  if (effectivePolicy === "TARGET_ID") {
    for (const id of existingProviderEntityIds) seen.add(`existing:${id}`);
  }
  const output: BlueprintItem[] = [];
  let omitted = 0;
  for (const item of items) {
    const key = itemDedupeKey(item, effectivePolicy);
    const existingKey = `existing:${item.target.providerEntityId}`;
    if ((key && seen.has(key)) || (effectivePolicy === "TARGET_ID" && seen.has(existingKey))) {
      omitted += 1;
      continue;
    }
    if (key) seen.add(key);
    output.push(item);
  }
  return { items: output, omitted };
}

function flattenSource(source: PlannerSourcePlaylist, destinationProvider: Provider): BlueprintItem[] {
  const sourcePlaylistId = requiredText(source.sourcePlaylistId, "sourcePlaylistId");
  const positions = new Set<number>();
  return source.selectedItems.map((item) => {
    assertSelectedItem(item, destinationProvider);
    if (positions.has(item.sourcePosition)) {
      throw new Error(`Duplicate source position ${item.sourcePosition} in playlist ${sourcePlaylistId}`);
    }
    positions.add(item.sourcePosition);
    return { ...item, sourcePlaylistId };
  });
}

function planKey(transferId: string, label: string): string {
  return `destination:v1:${lengthPrefixed(transferId)}|${lengthPrefixed(label)}`;
}

function resolveMaxItems(input: TransferPlannerInput): number | null {
  const max = input.destinationMaxItems === undefined
    ? input.destinationProvider === "soundcloud"
      ? 500
      : null
    : input.destinationMaxItems;
  if (max !== null && (!Number.isSafeInteger(max) || max <= 0)) {
    throw new RangeError("destinationMaxItems must be a positive integer or null");
  }
  return max;
}

function splitDestination(
  destination: DestinationBlueprint,
  maxItems: number | null,
  settings: TransferSettings,
): readonly DestinationBlueprint[] {
  if (maxItems === null || destination.items.length <= maxItems) return [destination];
  if (settings.soundcloudOverflow !== "SPLIT_WITH_CONFIRMATION") {
    throw new RangeError(`Destination ${destination.metadata.title} exceeds the ${maxItems}-item limit`);
  }
  if (destination.existingProviderPlaylistId) {
    throw new RangeError("An existing destination playlist cannot be split automatically");
  }
  const count = Math.ceil(destination.items.length / maxItems);
  return Array.from({ length: count }, (_, index) => ({
    ...destination,
    destinationPlanKey: `${destination.destinationPlanKey}:part:${index + 1}`,
    metadata: { ...destination.metadata, title: `${destination.metadata.title} — Part ${index + 1}` },
    items: destination.items.slice(index * maxItems, (index + 1) * maxItems),
    partNumber: index + 1,
    partCount: count,
  }));
}

function freezeBlueprint(blueprint: TransferBlueprint): TransferBlueprint {
  const destinations = blueprint.destinations.map((destination) =>
    Object.freeze({ ...destination, sourcePlaylistIds: Object.freeze([...destination.sourcePlaylistIds]), items: Object.freeze([...destination.items]), metadata: Object.freeze({ ...destination.metadata }) }),
  );
  return Object.freeze({ ...blueprint, destinations: Object.freeze(destinations) });
}

export function createTransferBlueprint(input: TransferPlannerInput): TransferBlueprint {
  requiredText(input.transferId, "transferId");
  if (input.sources.length === 0) throw new Error("At least one source playlist is required");
  validateTransferSettings(input.settings);
  const maxItems = resolveMaxItems(input);
  const sourceIds = new Set<string>();
  for (const source of input.sources) {
    const id = requiredText(source.sourcePlaylistId, "sourcePlaylistId");
    if (sourceIds.has(id)) throw new Error(`Duplicate source playlist selection: ${id}`);
    sourceIds.add(id);
  }

  let omittedDuplicateCount = 0;
  let destinations: DestinationBlueprint[] = [];

  if (input.mode === "SEPARATE_COPY") {
    for (const source of input.sources) {
      const flattened = flattenSource(source, input.destinationProvider);
      const deduped = dedupeItems(flattened, input.settings);
      omittedDuplicateCount += deduped.omitted;
      if (deduped.items.length === 0) continue;
      destinations.push({
        destinationPlanKey: planKey(input.transferId, `source:${source.sourcePlaylistId}`),
        sourcePlaylistIds: [source.sourcePlaylistId],
        metadata: {
          title: requiredText(source.title, "source title"),
          description: source.description,
          privacy: source.privacy,
          copyCover: input.settings.copyCover,
        },
        items: deduped.items,
      });
    }
  } else if (input.mode === "MERGE_NEW") {
    const flattened = input.sources.flatMap((source) => flattenSource(source, input.destinationProvider));
    const deduped = dedupeItems(flattened, input.settings);
    omittedDuplicateCount += deduped.omitted;
    if (deduped.items.length > 0) {
      destinations.push({
        destinationPlanKey: planKey(input.transferId, "merged"),
        sourcePlaylistIds: input.sources.map((source) => source.sourcePlaylistId),
        metadata: { ...input.mergedMetadata, title: requiredText(input.mergedMetadata.title, "merged title"), copyCover: input.settings.copyCover },
        items: deduped.items,
      });
    }
  } else {
    const destination = input.existingDestination;
    if (destination.eligibility === "INELIGIBLE") throw new Error("Existing destination is not eligible for writing");
    if (destination.currentItemCount < 0 || !Number.isSafeInteger(destination.currentItemCount)) {
      throw new RangeError("Existing destination item count must be a non-negative integer");
    }
    const flattened = input.sources.flatMap((source) => flattenSource(source, input.destinationProvider));
    const deduped = dedupeItems(flattened, input.settings, destination.existingProviderEntityIds);
    omittedDuplicateCount += deduped.omitted;
    if (maxItems !== null && destination.currentItemCount + deduped.items.length > maxItems) {
      throw new RangeError(`Append would exceed the ${maxItems}-item destination limit`);
    }
    if (deduped.items.length > 0) {
      destinations.push({
        destinationPlanKey: planKey(input.transferId, `existing:${destination.providerPlaylistId}`),
        existingProviderPlaylistId: requiredText(destination.providerPlaylistId, "existing destination playlist ID"),
        sourcePlaylistIds: input.sources.map((source) => source.sourcePlaylistId),
        metadata: { title: destination.title, copyCover: false },
        items: deduped.items,
      });
    }
  }

  destinations = destinations.flatMap((destination) => splitDestination(destination, maxItems, input.settings));
  return freezeBlueprint({
    transferId: input.transferId,
    mode: input.mode,
    destinationProvider: input.destinationProvider,
    settings: input.settings,
    destinations,
    orderGuaranteed: input.settings.preserveOrder,
    omittedDuplicateCount,
  });
}

export type DestinationBindings = Readonly<Record<string, string>>;

export function materializeWritePlan(
  blueprint: TransferBlueprint,
  destinationBindings: DestinationBindings = {},
): ImmutableWritePlan {
  const destinations: WritePlanDestination[] = blueprint.destinations.map((destination) => {
    const destinationPlaylistId = destination.existingProviderPlaylistId ?? destinationBindings[destination.destinationPlanKey];
    if (!destinationPlaylistId?.trim()) {
      throw new Error(`Missing real destination playlist ID for ${destination.destinationPlanKey}`);
    }
    const items = destination.items.map((item, destinationOrdinal): PlannedWriteItem => ({
      ...item,
      destinationPlaylistId,
      destinationOrdinal,
      idempotencyKey: createItemIdempotencyKey({
        transferId: blueprint.transferId,
        destinationPlaylistId,
        sourcePlaylistId: item.sourcePlaylistId,
        sourcePosition: item.sourcePosition,
        selectedTargetId: item.target.providerEntityId,
      }),
    }));
    return Object.freeze({ ...destination, destinationPlaylistId, items: Object.freeze(items) });
  });

  return Object.freeze({
    transferId: blueprint.transferId,
    mode: blueprint.mode,
    destinationProvider: blueprint.destinationProvider,
    destinations: Object.freeze(destinations),
    expectedItemWrites: destinations.reduce((total, destination) => total + destination.items.length, 0),
    expectedPlaylistCreates: destinations.filter((destination) => !destination.existingProviderPlaylistId).length,
    orderGuaranteed: blueprint.orderGuaranteed,
    omittedDuplicateCount: blueprint.omittedDuplicateCount,
  });
}
