import { z } from "zod";
import { apiError, apiOk, requireUnlockedProfile } from "../_shared";
import { requireCsrf, requireLocalRead } from "../../../packages/security/src/loopback-session";
import { getTransferCoordinator } from "../../../packages/orchestrator/src/coordinator";

export const dynamic = "force-dynamic";

const settingsSchema = z.object({
  matching: z.object({
    riskMode: z.enum(["SAFE", "RISKY"]).optional(),
    reviewUncertain: z.boolean().optional(),
    riskyRelevanceFallbackMinTitleSimilarity: z.number().min(0).max(1).optional(),
    maxReviewCandidates: z.number().int().min(3).max(5).optional(),
  }).optional(),
  preserveDuplicates: z.boolean().optional(),
  preserveOrder: z.boolean().optional(),
  dedupe: z.enum(["NONE", "TARGET_ID", "CONFIRMED_EQUIVALENCE"]).optional(),
  unavailableItems: z.enum(["CONTINUE_AND_REPORT", "STOP_BEFORE_WRITE"]).optional(),
  destinationPrivacy: z.enum(["PRIVATE", "UNLISTED", "PUBLIC", "PROVIDER_DEFAULT"]).optional(),
  privacyConfirmed: z.boolean().optional(),
  copyCover: z.boolean().optional(),
  coverRightsConfirmed: z.boolean().optional(),
  soundcloudOverflow: z.enum(["STOP", "SPLIT_WITH_CONFIRMATION"]).optional(),
}).optional();

const createSchema = z.object({
  sourceProvider: z.enum(["spotify", "soundcloud", "youtube"]),
  destinationProvider: z.enum(["spotify", "soundcloud", "youtube"]),
  mode: z.enum(["SEPARATE_COPY", "MERGE_NEW", "APPEND_EXISTING"]),
  selectedPlaylistIds: z.array(z.string().uuid().or(z.string().regex(/^[a-f0-9]{32}$/))).min(1).max(100),
  settings: settingsSchema,
  allowPartial: z.boolean().optional(),
  destination: z.object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().max(5_000).optional(),
    privacy: z.enum(["private", "unlisted", "public"]).optional(),
    playlistUrl: z.string().url().max(2_048).optional(),
    providerPlaylistId: z.string().trim().min(1).max(2_048).optional(),
    ownershipAttested: z.boolean().optional(),
    editControlAttested: z.boolean().optional(),
    existingItemIds: z.array(z.string().min(1).max(2_048)).max(100_000).optional(),
    existingItemCount: z.number().int().nonnegative().max(1_000_000).optional(),
  }).optional(),
});

export function GET(request: Request) {
  try {
    requireLocalRead(request);
    requireUnlockedProfile();
    return apiOk(getTransferCoordinator().list());
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireCsrf(request);
    requireUnlockedProfile();
    const input = createSchema.parse(await request.json());
    return apiOk(getTransferCoordinator().create(input), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
