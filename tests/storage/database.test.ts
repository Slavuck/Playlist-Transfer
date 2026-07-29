import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("legacy branded database is migrated into the canonical filename without losing encrypted state", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "playlist-transfer-legacy-migration-"));
  const currentFilename = path.join(directory, "playlist-transfer.sqlite");
  const previousFilename = path.join(directory, `${"app"}${"transfer"}.sqlite`);
  const legacyDatabase = new LocalDatabase(directory);
  const legacyVault = new LocalVault();
  legacyVault.createProfile(legacyDatabase, { displayName: "Existing profile", passphrase: "legacy horse battery" });
  legacyDatabase.saveConnection({
    provider: "spotify",
    accountLabel: "Existing account",
    strategy: "guided",
    status: "IDENTITY_SAVED",
    scopes: [],
    capabilities: { providerPasswordReceived: false },
  });
  legacyDatabase.close();
  renameSync(currentFilename, previousFilename);

  const emptyCanonical = new DatabaseSync(currentFilename);
  emptyCanonical.close();
  const migrated = new LocalDatabase(directory);
  assert.equal(migrated.filename, currentFilename);
  assert.equal(migrated.getProfile()?.displayName, "Existing profile");
  assert.equal(migrated.listConnections().length, 1);
  assert.equal(
    migrated.all<{ event_type: string }>("SELECT event_type FROM audit_events").some((event) => event.event_type === "LEGACY_LOCAL_DATABASE_MIGRATED"),
    true,
  );
  assert.equal(existsSync(previousFilename), true, "the legacy source remains as a recovery copy");
  migrated.destroyFiles();
});

test("a canonical database with user state is never replaced by a legacy database", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "playlist-transfer-canonical-wins-"));
  const current = new LocalDatabase(directory);
  const currentVault = new LocalVault();
  currentVault.createProfile(current, { displayName: "Canonical profile", passphrase: "canonical horse battery" });
  current.close();

  const legacyDirectory = mkdtempSync(path.join(tmpdir(), "playlist-transfer-legacy-source-"));
  const legacy = new LocalDatabase(legacyDirectory);
  const legacyVault = new LocalVault();
  legacyVault.createProfile(legacy, { displayName: "Legacy profile", passphrase: "legacy horse battery" });
  legacy.close();
  copyFileSync(
    path.join(legacyDirectory, "playlist-transfer.sqlite"),
    path.join(directory, `${"app"}${"transfer"}.sqlite`),
  );

  const reopened = new LocalDatabase(directory);
  assert.equal(reopened.getProfile()?.displayName, "Canonical profile");
  reopened.destroyFiles();
  rmSync(legacyDirectory, { recursive: true, force: true });
});

test("legacy migration moves an empty canonical WAL aside before copying user state", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "playlist-transfer-wal-migration-"));
  const walSourceDirectory = mkdtempSync(path.join(tmpdir(), "playlist-transfer-wal-source-"));
  const walSource = path.join(walSourceDirectory, "playlist-transfer.sqlite");
  const canonical = path.join(directory, "playlist-transfer.sqlite");
  const walDatabase = new DatabaseSync(walSource);
  walDatabase.exec("PRAGMA journal_mode = WAL");
  walDatabase.exec("PRAGMA wal_autocheckpoint = 0");
  walDatabase.exec("CREATE TABLE local_profile(id TEXT PRIMARY KEY)");
  copyFileSync(walSource, canonical);
  copyFileSync(`${walSource}-wal`, `${canonical}-wal`);
  copyFileSync(`${walSource}-shm`, `${canonical}-shm`);
  walDatabase.close();

  const legacyDirectory = mkdtempSync(path.join(tmpdir(), "playlist-transfer-wal-legacy-"));
  const legacy = new LocalDatabase(legacyDirectory);
  const legacyVault = new LocalVault();
  legacyVault.createProfile(legacy, { displayName: "WAL recovery profile", passphrase: "wal recovery horse battery" });
  legacy.close();
  copyFileSync(
    path.join(legacyDirectory, "playlist-transfer.sqlite"),
    path.join(directory, `${"app"}${"transfer"}.sqlite`),
  );

  const migrated = new LocalDatabase(directory);
  assert.equal(migrated.getProfile()?.displayName, "WAL recovery profile");
  const migrationBackups = readdirSync(directory).filter((name) => name.includes("empty-before-legacy-migration"));
  assert.equal(migrationBackups.some((name) => name.endsWith(".bak")), true);
  assert.equal(migrationBackups.some((name) => name.endsWith(".bak.wal")), true);
  migrated.destroyFiles();
  rmSync(walSourceDirectory, { recursive: true, force: true });
  rmSync(legacyDirectory, { recursive: true, force: true });
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
