import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalDatabase } from "../../packages/storage-local/src/database";
import { createPortableEncryptedBackup, LocalVault, openPortableEncryptedBackup, redactSecrets } from "../../packages/storage-local/src/vault";

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "playlist-transfer-test-"));
  return new LocalDatabase(directory);
}

test("local profile vault encrypts, locks and rejects a wrong passphrase", () => {
  const db = temporaryDatabase();
  const vault = new LocalVault();
  vault.createProfile(db, { displayName: "Test", passphrase: "correct horse battery" });
  const sealed = vault.sealJson({ accessToken: "secret-value" }, "youtube");
  assert.equal(sealed.includes("secret-value"), false);
  vault.lock();
  assert.equal(vault.unlock(db, "wrong passphrase"), false);
  assert.equal(vault.unlock(db, "correct horse battery"), true);
  assert.deepEqual(vault.openJson(sealed, "youtube"), { accessToken: "secret-value" });
  db.destroyFiles();
});

test("handoff claim is one-time and expired handoffs fail closed", () => {
  const db = temporaryDatabase();
  const handoff = db.createHandoff({ provider: "youtube", videoId: "abcdefghijk" }, "checksum", 1_000);
  const claimed = db.claimHandoff(handoff);
  assert.equal((claimed?.payload as { videoId?: string } | undefined)?.videoId, "abcdefghijk");
  assert.equal(db.claimHandoff(handoff), undefined);
  const expired = db.createHandoff({ provider: "spotify" }, "checksum", 1);
  assert.equal(db.claimHandoff(expired, Date.now() + 50), undefined);
  db.destroyFiles();
});

test("quota ledger refuses an operation that would exceed a bucket", () => {
  const db = temporaryDatabase();
  assert.equal(db.useQuota("youtube", "search", "2026-07-29", 99, 100), true);
  assert.equal(db.useQuota("youtube", "search", "2026-07-29", 2, 100), false);
  assert.equal(db.useQuota("youtube", "search", "2026-07-29", 1, 100), true);
  db.destroyFiles();
});

test("redaction removes structured and URL secrets", () => {
  const redacted = redactSecrets({
    access_token: "abc",
    nested: { value: "Bearer xyz", url: "https://soundcloud.com/a/b?secret_token=s-123" },
  }) as Record<string, unknown>;
  assert.equal(redacted.access_token, "[REDACTED]");
  assert.equal(JSON.stringify(redacted).includes("s-123"), false);
  assert.equal(JSON.stringify(redacted).includes("Bearer xyz"), false);
});

test("portable backups are encrypted and require their own passphrase", () => {
  const backup = createPortableEncryptedBackup({ refreshToken: "do-not-leak" }, "backup horse battery");
  assert.equal(backup.includes("do-not-leak"), false);
  assert.throws(() => openPortableEncryptedBackup(backup, "wrong passphrase"));
  assert.deepEqual(openPortableEncryptedBackup(backup, "backup horse battery"), { refreshToken: "do-not-leak" });
});
