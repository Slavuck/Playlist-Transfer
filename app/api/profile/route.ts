import { z } from "zod";
import { apiError, apiOk } from "../_shared";
import { rateLimit, requireCsrf, requireLocalRead } from "../../../packages/security/src/loopback-session";
import { getLocalDatabase } from "../../../packages/storage-local/src/database";
import { getLocalVault } from "../../../packages/storage-local/src/vault";

export const dynamic = "force-dynamic";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), displayName: z.string().trim().min(1).max(80), passphrase: z.string().min(10).max(512), language: z.enum(["ru", "en"]).default("ru") }),
  z.object({ action: z.literal("unlock"), passphrase: z.string().min(1).max(512) }),
  z.object({ action: z.literal("lock") }),
  z.object({ action: z.literal("set-language"), language: z.enum(["ru", "en"]) }),
]);

function publicProfile() {
  const database = getLocalDatabase();
  const vault = getLocalVault();
  const profile = database.getProfile();
  return {
    exists: Boolean(profile),
    unlocked: vault.isUnlocked,
    profile: profile ? { id: profile.id, displayName: profile.displayName, language: profile.language, createdAtMs: profile.createdAtMs } : undefined,
  };
}

export function GET(request: Request) {
  try {
    requireLocalRead(request);
    return apiOk(publicProfile());
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireCsrf(request);
    rateLimit("profile-mutation", 10, 60_000);
    const input = actionSchema.parse(await request.json());
    const database = getLocalDatabase();
    const vault = getLocalVault();
    if (input.action === "set-language" && !vault.isUnlocked) throw new Error("VAULT_LOCKED");
    if (input.action === "create") vault.createProfile(database, input);
    else if (input.action === "unlock") {
      if (!vault.unlock(database, input.passphrase)) throw new Error("INVALID_LOCAL_PASSPHRASE");
    } else if (input.action === "set-language") {
      const profile = database.getProfile();
      if (!profile) throw new Error("PROFILE_NOT_FOUND");
      database.saveProfile({ ...profile, language: input.language, updatedAtMs: Date.now() });
    } else vault.lock();
    return apiOk(publicProfile());
  } catch (error) {
    return apiError(error);
  }
}
