import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { LocalDatabase } from "./database";

const VERIFIER_TEXT = "playlist-transfer-local-vault-v1";
const PREVIOUS_VERIFIER_TEXT = `${"plan-app"}${"transfer-local-vault-v1"}`;
const KEY_BYTES = 32;

type SealedPayload = {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, KEY_BYTES, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function sealWithKey(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const payload: SealedPayload = {
    v: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function openWithKey(key: Buffer, sealed: string, aad: string): Buffer {
  const payload = JSON.parse(Buffer.from(sealed, "base64url").toString("utf8")) as SealedPayload;
  if (payload.v !== 1) throw new Error("UNSUPPORTED_VAULT_VERSION");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final(),
  ]);
}

export class LocalVault {
  private key?: Buffer;
  private profileId?: string;

  get isUnlocked() {
    return Boolean(this.key && this.profileId);
  }

  createProfile(
    database: LocalDatabase,
    input: { displayName: string; passphrase: string; language?: "ru" | "en" },
  ) {
    if (database.getProfile()) throw new Error("PROFILE_ALREADY_EXISTS");
    if (input.passphrase.length < 10) throw new Error("PASSPHRASE_TOO_SHORT");
    const salt = randomBytes(16);
    const key = deriveKey(input.passphrase, salt);
    const id = randomUUID();
    const verifier = sealWithKey(key, Buffer.from(VERIFIER_TEXT, "utf8"), `profile:${id}`);
    const now = Date.now();
    database.saveProfile({
      id,
      displayName: input.displayName.trim() || "Local user",
      language: input.language ?? "ru",
      saltB64: salt.toString("base64url"),
      verifier,
      createdAtMs: now,
      updatedAtMs: now,
    });
    this.replaceKey(key, id);
  }

  unlock(database: LocalDatabase, passphrase: string): boolean {
    const profile = database.getProfile();
    if (!profile) throw new Error("PROFILE_NOT_FOUND");
    const key = deriveKey(passphrase, Buffer.from(profile.saltB64, "base64url"));
    try {
      const opened = openWithKey(key, profile.verifier, `profile:${profile.id}`);
      const expected = Buffer.from(VERIFIER_TEXT, "utf8");
      const previous = Buffer.from(PREVIOUS_VERIFIER_TEXT, "utf8");
      const valid = (opened.length === expected.length && timingSafeEqual(opened, expected))
        || (opened.length === previous.length && timingSafeEqual(opened, previous));
      opened.fill(0);
      previous.fill(0);
      if (!valid) {
        key.fill(0);
        return false;
      }
      if (profile.verifier && valid) {
        database.saveProfile({
          ...profile,
          verifier: sealWithKey(key, Buffer.from(VERIFIER_TEXT, "utf8"), `profile:${profile.id}`),
          updatedAtMs: Date.now(),
        });
      }
      this.replaceKey(key, profile.id);
      return true;
    } catch {
      key.fill(0);
      return false;
    }
  }

  lock() {
    this.key?.fill(0);
    this.key = undefined;
    this.profileId = undefined;
  }

  sealJson(value: unknown, purpose: string): string {
    if (!this.key || !this.profileId) throw new Error("VAULT_LOCKED");
    return sealWithKey(this.key, Buffer.from(JSON.stringify(value), "utf8"), `${this.profileId}:${purpose}`);
  }

  openJson<T>(sealed: string, purpose: string): T {
    if (!this.key || !this.profileId) throw new Error("VAULT_LOCKED");
    const opened = openWithKey(this.key, sealed, `${this.profileId}:${purpose}`);
    try {
      return JSON.parse(opened.toString("utf8")) as T;
    } finally {
      opened.fill(0);
    }
  }

  private replaceKey(key: Buffer, profileId: string) {
    this.lock();
    this.key = key;
    this.profileId = profileId;
  }
}

declare global {
  var __playlistTransferVault: LocalVault | undefined;
}

export function getLocalVault(): LocalVault {
  if (!globalThis.__playlistTransferVault) globalThis.__playlistTransferVault = new LocalVault();
  return globalThis.__playlistTransferVault;
}

export function createPortableEncryptedBackup(value: unknown, passphrase: string): string {
  if (passphrase.length < 10) throw new Error("BACKUP_PASSPHRASE_TOO_SHORT");
  const salt = randomBytes(16);
  const key = deriveKey(passphrase, salt);
  try {
    return JSON.stringify({
      format: "playlist-transfer-backup",
      version: 1,
      kdf: "scrypt-N16384-r8-p1",
      salt: salt.toString("base64url"),
      payload: sealWithKey(key, Buffer.from(JSON.stringify(value), "utf8"), "portable-backup:v1"),
    });
  } finally {
    key.fill(0);
  }
}

export function openPortableEncryptedBackup<T>(backup: string, passphrase: string): T {
  const envelope = JSON.parse(backup) as { format?: string; version?: number; salt?: string; payload?: string };
  const previousFormat = `${"plan-app"}${"transfer-backup"}`;
  if (!["playlist-transfer-backup", previousFormat].includes(envelope.format ?? "") || envelope.version !== 1 || !envelope.salt || !envelope.payload) {
    throw new Error("INVALID_BACKUP_FORMAT");
  }
  const key = deriveKey(passphrase, Buffer.from(envelope.salt, "base64url"));
  try {
    const opened = openWithKey(key, envelope.payload, "portable-backup:v1");
    try {
      return JSON.parse(opened.toString("utf8")) as T;
    } finally {
      opened.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

const SECRET_KEY = /(authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret_token)/i;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(entry),
      ]),
    );
  }
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()]) {
        if (SECRET_KEY.test(key) || key.startsWith("s-")) url.searchParams.set(key, "[REDACTED]");
      }
      return url.toString();
    } catch {
      return value.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]");
    }
  }
  return value;
}
