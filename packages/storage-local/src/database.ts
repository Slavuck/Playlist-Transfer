import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION, schemaStatements } from "./schema";

export type JsonObject = Record<string, unknown>;

export type ProfileRow = {
  id: string;
  displayName: string;
  language: "ru" | "en";
  saltB64: string;
  verifier: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type ConnectionRecord = {
  provider: "spotify" | "soundcloud" | "youtube";
  accountId?: string;
  accountLabel: string;
  profileUrl?: string;
  strategy: "guided" | "api";
  status: string;
  scopes: string[];
  capabilities: JsonObject;
  encryptedSecret?: string;
  authorizedAtMs?: number;
  expiresAtMs?: number;
  updatedAtMs?: number;
};

export type TransferRecord = {
  id: string;
  state: string;
  sourceProvider: string;
  destinationProvider: string;
  mode: string;
  settings: JsonObject;
  selectedPlaylistIds: string[];
  destination: JsonObject;
  writePlan?: JsonObject;
  limitationCodes: string[];
  errorCode?: string;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
};

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

export class LocalDatabase {
  readonly directory: string;
  readonly filename: string;
  private readonly sqlite: DatabaseSync;

  constructor(directory = process.env.PLAYLIST_TRANSFER_DATA_DIR || path.join(process.cwd(), ".data")) {
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const currentFilename = path.join(this.directory, "playlist-transfer.sqlite");
    const previousFilename = path.join(this.directory, `${"app"}${"transfer"}.sqlite`);
    this.filename = existsSync(currentFilename) || !existsSync(previousFilename) ? currentFilename : previousFilename;
    this.sqlite = new DatabaseSync(this.filename);
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec("PRAGMA journal_mode = WAL");
    this.sqlite.exec("PRAGMA synchronous = FULL");
    this.migrate();
  }

  private migrate() {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of schemaStatements) this.sqlite.exec(statement);
      this.sqlite
        .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at_ms) VALUES (?, ?)")
        .run(SCHEMA_VERSION, Date.now());
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.sqlite.close();
  }

  transaction<T>(work: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  run(sql: string, ...values: SQLInputValue[]) {
    return this.sqlite.prepare(sql).run(...values);
  }

  get<T extends JsonObject>(sql: string, ...values: SQLInputValue[]): T | undefined {
    return this.sqlite.prepare(sql).get(...values) as T | undefined;
  }

  all<T extends JsonObject>(sql: string, ...values: SQLInputValue[]): T[] {
    return this.sqlite.prepare(sql).all(...values) as T[];
  }

  getProfile(): ProfileRow | undefined {
    const row = this.get<JsonObject>("SELECT * FROM local_profile LIMIT 1");
    if (!row) return undefined;
    return {
      id: String(row.id),
      displayName: String(row.display_name),
      language: row.language === "en" ? "en" : "ru",
      saltB64: String(row.salt_b64),
      verifier: String(row.verifier),
      createdAtMs: asNumber(row.created_at_ms),
      updatedAtMs: asNumber(row.updated_at_ms),
    };
  }

  saveProfile(profile: ProfileRow) {
    this.run(
      `INSERT INTO local_profile(id, display_name, language, salt_b64, verifier, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,
       language=excluded.language, salt_b64=excluded.salt_b64,
       verifier=excluded.verifier, updated_at_ms=excluded.updated_at_ms`,
      profile.id,
      profile.displayName,
      profile.language,
      profile.saltB64,
      profile.verifier,
      profile.createdAtMs,
      profile.updatedAtMs,
    );
  }

  saveConnection(connection: ConnectionRecord) {
    const now = connection.updatedAtMs ?? Date.now();
    this.run(
      `INSERT INTO service_connections(provider, account_id, account_label, profile_url, strategy, status,
       scopes_json, capabilities_json, encrypted_secret, authorized_at_ms, expires_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET account_id=excluded.account_id, account_label=excluded.account_label,
       profile_url=excluded.profile_url, strategy=excluded.strategy, status=excluded.status,
       scopes_json=excluded.scopes_json, capabilities_json=excluded.capabilities_json,
       encrypted_secret=excluded.encrypted_secret, authorized_at_ms=excluded.authorized_at_ms,
       expires_at_ms=excluded.expires_at_ms, updated_at_ms=excluded.updated_at_ms`,
      connection.provider,
      connection.accountId ?? null,
      connection.accountLabel,
      connection.profileUrl ?? null,
      connection.strategy,
      connection.status,
      JSON.stringify(connection.scopes),
      JSON.stringify(connection.capabilities),
      connection.encryptedSecret ?? null,
      connection.authorizedAtMs ?? null,
      connection.expiresAtMs ?? null,
      now,
    );
  }

  listConnections(): ConnectionRecord[] {
    return this.all<JsonObject>("SELECT * FROM service_connections ORDER BY provider").map((row) => ({
      provider: String(row.provider) as ConnectionRecord["provider"],
      accountId: row.account_id ? String(row.account_id) : undefined,
      accountLabel: String(row.account_label),
      profileUrl: row.profile_url ? String(row.profile_url) : undefined,
      strategy: row.strategy === "api" ? "api" : "guided",
      status: String(row.status),
      scopes: parseJson<string[]>(row.scopes_json, []),
      capabilities: parseJson<JsonObject>(row.capabilities_json, {}),
      encryptedSecret: row.encrypted_secret ? String(row.encrypted_secret) : undefined,
      authorizedAtMs: row.authorized_at_ms ? asNumber(row.authorized_at_ms) : undefined,
      expiresAtMs: row.expires_at_ms ? asNumber(row.expires_at_ms) : undefined,
      updatedAtMs: asNumber(row.updated_at_ms),
    }));
  }

  getConnection(provider: ConnectionRecord["provider"]): ConnectionRecord | undefined {
    return this.listConnections().find((connection) => connection.provider === provider);
  }

  deleteConnection(provider: ConnectionRecord["provider"]) {
    this.transaction(() => {
      const active = this.get<JsonObject>(
        `SELECT 1 AS active FROM transfer_leases AS lease
         JOIN transfers AS transfer ON transfer.id = lease.transfer_id
         WHERE lease.expires_at_ms > ?
         AND (transfer.source_provider = ? OR transfer.destination_provider = ?)
         LIMIT 1`,
        Date.now(),
        provider,
        provider,
      );
      if (active) throw new Error("ACTIVE_PROVIDER_OPERATION");
      this.run("DELETE FROM service_connections WHERE provider = ?", provider);
      this.audit("CONNECTION_DELETED", provider, {});
    });
  }

  deleteProviderData(provider: ConnectionRecord["provider"]) {
    this.transaction(() => {
      const active = this.get<JsonObject>(
        `SELECT 1 AS active FROM transfers
         WHERE state NOT IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')
         AND (source_provider = ? OR destination_provider = ?)
         LIMIT 1`,
        provider,
        provider,
      );
      if (active) throw new Error("ACTIVE_PROVIDER_OPERATION");
      this.run(
        `DELETE FROM audit_events WHERE subject_id IN (
          SELECT id FROM transfers WHERE source_provider = ? OR destination_provider = ?
        )`,
        provider,
        provider,
      );
      this.run("DELETE FROM transfers WHERE source_provider = ? OR destination_provider = ?", provider, provider);
      this.run("DELETE FROM playlist_snapshots WHERE provider = ?", provider);
      this.run("DELETE FROM quota_ledger WHERE provider = ?", provider);
      this.run("DELETE FROM service_connections WHERE provider = ?", provider);
      this.audit("PROVIDER_DATA_DELETED", provider, { relatedTransfersDeleted: true, snapshotsDeleted: true });
    });
  }

  savePlaylistSnapshot(input: {
    id?: string;
    provider: string;
    providerPlaylistId?: string;
    providerUrl: string;
    title: string;
    description?: string;
    ownerLabel: string;
    eligibility: string;
    eligibilityEvidence: JsonObject;
    partial: boolean;
    sourceVersion: string;
    snapshot: JsonObject;
    expiresAtMs?: number;
  }): string {
    const id = input.id ?? randomUUID();
    const tracks = Array.isArray(input.snapshot.tracks) ? input.snapshot.tracks : [];
    const now = Date.now();
    this.run(
      `INSERT INTO playlist_snapshots(id, provider, provider_playlist_id, provider_url, title, description,
       owner_label, eligibility, eligibility_evidence_json, item_count, partial, source_version,
       snapshot_json, created_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET provider_playlist_id=excluded.provider_playlist_id,
       provider_url=excluded.provider_url, title=excluded.title, description=excluded.description,
       owner_label=excluded.owner_label, eligibility=excluded.eligibility,
       eligibility_evidence_json=excluded.eligibility_evidence_json, item_count=excluded.item_count,
       partial=excluded.partial, source_version=excluded.source_version,
       snapshot_json=excluded.snapshot_json, expires_at_ms=excluded.expires_at_ms`,
      id,
      input.provider,
      input.providerPlaylistId ?? null,
      input.providerUrl,
      input.title,
      input.description ?? "",
      input.ownerLabel,
      input.eligibility,
      JSON.stringify(input.eligibilityEvidence),
      tracks.length,
      input.partial ? 1 : 0,
      input.sourceVersion,
      JSON.stringify(input.snapshot),
      now,
      input.expiresAtMs ?? now + 24 * 60 * 60 * 1000,
    );
    return id;
  }

  listPlaylistSnapshots(provider?: string): JsonObject[] {
    const rows = provider
      ? this.all<JsonObject>("SELECT * FROM playlist_snapshots WHERE provider = ? ORDER BY created_at_ms DESC", provider)
      : this.all<JsonObject>("SELECT * FROM playlist_snapshots ORDER BY created_at_ms DESC");
    return rows.map((row) => ({
      id: String(row.id),
      provider: String(row.provider),
      providerPlaylistId: row.provider_playlist_id ? String(row.provider_playlist_id) : undefined,
      providerUrl: String(row.provider_url),
      title: String(row.title),
      description: String(row.description),
      ownerLabel: String(row.owner_label),
      eligibility: String(row.eligibility),
      eligibilityEvidence: parseJson<JsonObject>(row.eligibility_evidence_json, {}),
      itemCount: asNumber(row.item_count),
      partial: asNumber(row.partial) === 1,
      sourceVersion: String(row.source_version),
      snapshot: parseJson<JsonObject>(row.snapshot_json, {}),
      createdAtMs: asNumber(row.created_at_ms),
      expiresAtMs: asNumber(row.expires_at_ms),
    }));
  }

  saveTransfer(record: TransferRecord) {
    this.run(
      `INSERT INTO transfers(id, state, source_provider, destination_provider, mode, settings_json,
       selected_playlist_ids_json, destination_json, write_plan_json, limitation_codes_json,
       error_code, created_at_ms, updated_at_ms, completed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state=excluded.state, settings_json=excluded.settings_json,
       selected_playlist_ids_json=excluded.selected_playlist_ids_json, destination_json=excluded.destination_json,
       write_plan_json=excluded.write_plan_json, limitation_codes_json=excluded.limitation_codes_json,
       error_code=excluded.error_code, updated_at_ms=excluded.updated_at_ms,
       completed_at_ms=excluded.completed_at_ms`,
      record.id,
      record.state,
      record.sourceProvider,
      record.destinationProvider,
      record.mode,
      JSON.stringify(record.settings),
      JSON.stringify(record.selectedPlaylistIds),
      JSON.stringify(record.destination),
      record.writePlan ? JSON.stringify(record.writePlan) : null,
      JSON.stringify(record.limitationCodes),
      record.errorCode ?? null,
      record.createdAtMs,
      record.updatedAtMs,
      record.completedAtMs ?? null,
    );
  }

  private mapTransfer(row: JsonObject): TransferRecord {
    return {
      id: String(row.id),
      state: String(row.state),
      sourceProvider: String(row.source_provider),
      destinationProvider: String(row.destination_provider),
      mode: String(row.mode),
      settings: parseJson<JsonObject>(row.settings_json, {}),
      selectedPlaylistIds: parseJson<string[]>(row.selected_playlist_ids_json, []),
      destination: parseJson<JsonObject>(row.destination_json, {}),
      writePlan: row.write_plan_json ? parseJson<JsonObject>(row.write_plan_json, {}) : undefined,
      limitationCodes: parseJson<string[]>(row.limitation_codes_json, []),
      errorCode: row.error_code ? String(row.error_code) : undefined,
      createdAtMs: asNumber(row.created_at_ms),
      updatedAtMs: asNumber(row.updated_at_ms),
      completedAtMs: row.completed_at_ms ? asNumber(row.completed_at_ms) : undefined,
    };
  }

  getTransfer(id: string): TransferRecord | undefined {
    const row = this.get<JsonObject>("SELECT * FROM transfers WHERE id = ?", id);
    return row ? this.mapTransfer(row) : undefined;
  }

  listTransfers(limit = 50): TransferRecord[] {
    return this.all<JsonObject>("SELECT * FROM transfers ORDER BY updated_at_ms DESC LIMIT ?", limit).map((row) => this.mapTransfer(row));
  }

  acquireTransferLease(
    transferId: string,
    ownerId: string,
    ttlMs = 120_000,
    now = Date.now(),
  ): boolean {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000) throw new Error("INVALID_TRANSFER_LEASE_TTL");
    return this.transaction(() => {
      const current = this.get<JsonObject>(
        "SELECT owner_id, expires_at_ms FROM transfer_leases WHERE transfer_id = ?",
        transferId,
      );
      if (current && String(current.owner_id) !== ownerId && asNumber(current.expires_at_ms) > now) {
        return false;
      }
      this.run(
        `INSERT INTO transfer_leases(transfer_id, owner_id, expires_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?) ON CONFLICT(transfer_id) DO UPDATE SET
         owner_id=excluded.owner_id, expires_at_ms=excluded.expires_at_ms,
         updated_at_ms=excluded.updated_at_ms`,
        transferId,
        ownerId,
        now + ttlMs,
        now,
      );
      return true;
    });
  }

  renewTransferLease(transferId: string, ownerId: string, ttlMs = 120_000, now = Date.now()): boolean {
    const result = this.run(
      `UPDATE transfer_leases SET expires_at_ms = ?, updated_at_ms = ?
       WHERE transfer_id = ? AND owner_id = ? AND expires_at_ms > ?`,
      now + ttlMs,
      now,
      transferId,
      ownerId,
      now,
    );
    return Number(result.changes) === 1;
  }

  releaseTransferLease(transferId: string, ownerId: string): void {
    this.run("DELETE FROM transfer_leases WHERE transfer_id = ? AND owner_id = ?", transferId, ownerId);
  }

  acquireResourceLease(resourceKey: string, ownerId: string, ttlMs = 120_000, now = Date.now()): boolean {
    if (!resourceKey.trim()) throw new Error("RESOURCE_LEASE_KEY_REQUIRED");
    return this.transaction(() => {
      const current = this.get<JsonObject>(
        "SELECT owner_id, expires_at_ms FROM resource_leases WHERE resource_key = ?",
        resourceKey,
      );
      if (current && String(current.owner_id) !== ownerId && asNumber(current.expires_at_ms) > now) return false;
      this.run(
        `INSERT INTO resource_leases(resource_key, owner_id, expires_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?) ON CONFLICT(resource_key) DO UPDATE SET
         owner_id=excluded.owner_id, expires_at_ms=excluded.expires_at_ms,
         updated_at_ms=excluded.updated_at_ms`,
        resourceKey,
        ownerId,
        now + ttlMs,
        now,
      );
      return true;
    });
  }

  renewResourceLease(resourceKey: string, ownerId: string, ttlMs = 120_000, now = Date.now()): boolean {
    const result = this.run(
      `UPDATE resource_leases SET expires_at_ms = ?, updated_at_ms = ?
       WHERE resource_key = ? AND owner_id = ? AND expires_at_ms > ?`,
      now + ttlMs,
      now,
      resourceKey,
      ownerId,
      now,
    );
    return Number(result.changes) === 1;
  }

  releaseResourceLease(resourceKey: string, ownerId: string): void {
    this.run("DELETE FROM resource_leases WHERE resource_key = ? AND owner_id = ?", resourceKey, ownerId);
  }

  saveTransferItem(item: {
    id: string;
    transferId: string;
    sourcePlaylistId: string;
    sourcePosition: number;
    state: string;
    sourceRef: JsonObject;
    hypotheses?: unknown[];
    candidates?: unknown[];
    decision?: JsonObject;
    selectedTarget?: JsonObject;
    idempotencyKey?: string;
    riskFlags?: string[];
  }) {
    this.run(
      `INSERT INTO transfer_items(id, transfer_id, source_playlist_id, source_position, state,
       source_ref_json, hypotheses_json, candidates_json, decision_json, selected_target_json,
       idempotency_key, risk_flags_json, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state=excluded.state, hypotheses_json=excluded.hypotheses_json,
       candidates_json=excluded.candidates_json, decision_json=excluded.decision_json,
       selected_target_json=excluded.selected_target_json, idempotency_key=excluded.idempotency_key,
       risk_flags_json=excluded.risk_flags_json, updated_at_ms=excluded.updated_at_ms`,
      item.id,
      item.transferId,
      item.sourcePlaylistId,
      item.sourcePosition,
      item.state,
      JSON.stringify(item.sourceRef),
      JSON.stringify(item.hypotheses ?? []),
      JSON.stringify(item.candidates ?? []),
      item.decision ? JSON.stringify(item.decision) : null,
      item.selectedTarget ? JSON.stringify(item.selectedTarget) : null,
      item.idempotencyKey ?? null,
      JSON.stringify(item.riskFlags ?? []),
      Date.now(),
    );
  }

  listTransferItems(transferId: string): JsonObject[] {
    return this.all<JsonObject>(
      "SELECT * FROM transfer_items WHERE transfer_id = ? ORDER BY source_playlist_id, source_position",
      transferId,
    ).map((row) => ({
      id: String(row.id),
      transferId: String(row.transfer_id),
      sourcePlaylistId: String(row.source_playlist_id),
      sourcePosition: asNumber(row.source_position),
      state: String(row.state),
      sourceRef: parseJson<JsonObject>(row.source_ref_json, {}),
      hypotheses: parseJson<unknown[]>(row.hypotheses_json, []),
      candidates: parseJson<unknown[]>(row.candidates_json, []),
      decision: row.decision_json ? parseJson<JsonObject>(row.decision_json, {}) : undefined,
      selectedTarget: row.selected_target_json ? parseJson<JsonObject>(row.selected_target_json, {}) : undefined,
      idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
      riskFlags: parseJson<string[]>(row.risk_flags_json, []),
      updatedAtMs: asNumber(row.updated_at_ms),
    }));
  }

  getTransferItem(transferId: string, itemId: string): JsonObject | undefined {
    return this.listTransferItems(transferId).find((item) => item.id === itemId);
  }

  saveReviewDecision(transferItemId: string, decision: JsonObject, actor = "LOCAL_USER") {
    this.transaction(() => {
      const now = Date.now();
      this.run(
        `INSERT INTO review_decisions(transfer_item_id, decision_json, actor, decided_at_ms)
         VALUES (?, ?, ?, ?) ON CONFLICT(transfer_item_id) DO UPDATE SET
         decision_json=excluded.decision_json, actor=excluded.actor, decided_at_ms=excluded.decided_at_ms`,
        transferItemId,
        JSON.stringify(decision),
        actor,
        now,
      );
      this.run(
        "UPDATE transfer_items SET decision_json = ?, updated_at_ms = ? WHERE id = ?",
        JSON.stringify(decision),
        now,
        transferItemId,
      );
    });
  }

  appendJournal(input: {
    transferId: string;
    sequence: number;
    stepKind: string;
    stepKey: string;
    status: string;
    payload?: JsonObject;
    attempt?: number;
  }) {
    const now = Date.now();
    this.run(
      `INSERT INTO local_job_journal(transfer_id, sequence, step_kind, step_key, status, payload_json,
       attempt, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(transfer_id, step_key) DO UPDATE SET status=excluded.status,
       payload_json=excluded.payload_json, attempt=excluded.attempt, updated_at_ms=excluded.updated_at_ms`,
      input.transferId,
      input.sequence,
      input.stepKind,
      input.stepKey,
      input.status,
      JSON.stringify(input.payload ?? {}),
      input.attempt ?? 0,
      now,
      now,
    );
  }

  listJournal(transferId: string): JsonObject[] {
    return this.all<JsonObject>(
      "SELECT * FROM local_job_journal WHERE transfer_id = ? ORDER BY sequence, id",
      transferId,
    ).map((row) => ({
      id: asNumber(row.id),
      sequence: asNumber(row.sequence),
      stepKind: String(row.step_kind),
      stepKey: String(row.step_key),
      status: String(row.status),
      payload: parseJson<JsonObject>(row.payload_json, {}),
      attempt: asNumber(row.attempt),
      createdAtMs: asNumber(row.created_at_ms),
      updatedAtMs: asNumber(row.updated_at_ms),
    }));
  }

  saveReceipt(receipt: {
    id?: string;
    transferId: string;
    transferItemId: string;
    destinationPlaylistId: string;
    targetEntityId: string;
    idempotencyKey: string;
    executionStatus: string;
    verificationStatus: string;
    evidence: JsonObject;
    risky?: boolean;
    manual?: boolean;
  }): string {
    const id = receipt.id ?? randomUUID();
    this.run(
      `INSERT INTO write_receipts(id, transfer_id, transfer_item_id, destination_playlist_id,
       target_entity_id, idempotency_key, execution_status, verification_status, evidence_json,
       risky, manual, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET execution_status=excluded.execution_status,
       verification_status=excluded.verification_status, evidence_json=excluded.evidence_json,
       risky=excluded.risky, manual=excluded.manual`,
      id,
      receipt.transferId,
      receipt.transferItemId,
      receipt.destinationPlaylistId,
      receipt.targetEntityId,
      receipt.idempotencyKey,
      receipt.executionStatus,
      receipt.verificationStatus,
      JSON.stringify(receipt.evidence),
      receipt.risky ? 1 : 0,
      receipt.manual ? 1 : 0,
      Date.now(),
    );
    return id;
  }

  listReceipts(transferId: string): JsonObject[] {
    return this.all<JsonObject>("SELECT * FROM write_receipts WHERE transfer_id = ? ORDER BY created_at_ms", transferId).map((row) => ({
      id: String(row.id),
      transferItemId: String(row.transfer_item_id),
      destinationPlaylistId: String(row.destination_playlist_id),
      targetEntityId: String(row.target_entity_id),
      idempotencyKey: String(row.idempotency_key),
      executionStatus: String(row.execution_status),
      verificationStatus: String(row.verification_status),
      evidence: parseJson<JsonObject>(row.evidence_json, {}),
      risky: asNumber(row.risky) === 1,
      manual: asNumber(row.manual) === 1,
      createdAtMs: asNumber(row.created_at_ms),
    }));
  }

  createHandoff(payload: JsonObject, checksum: string, ttlMs = 5 * 60 * 1000): string {
    const id = randomUUID();
    const now = Date.now();
    this.run(
      "INSERT INTO extension_handoffs(id, payload_json, checksum, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?)",
      id,
      JSON.stringify(payload),
      checksum,
      now + ttlMs,
      now,
    );
    return id;
  }

  claimHandoff(id: string, now = Date.now()): JsonObject | undefined {
    return this.transaction(() => {
      const row = this.get<JsonObject>(
        "SELECT * FROM extension_handoffs WHERE id = ? AND claimed_at_ms IS NULL AND expires_at_ms >= ?",
        id,
        now,
      );
      if (!row) return undefined;
      this.run("UPDATE extension_handoffs SET claimed_at_ms = ?, payload_json = '{}' WHERE id = ? AND claimed_at_ms IS NULL", now, id);
      return {
        payload: parseJson<JsonObject>(row.payload_json, {}),
        checksum: String(row.checksum),
        createdAtMs: asNumber(row.created_at_ms),
      };
    });
  }

  useQuota(provider: string, bucket: string, periodKey: string, amount: number, limit: number): boolean {
    return this.transaction(() => {
      const row = this.get<JsonObject>(
        "SELECT used FROM quota_ledger WHERE provider = ? AND bucket = ? AND period_key = ?",
        provider,
        bucket,
        periodKey,
      );
      const used = row ? asNumber(row.used) : 0;
      if (used + amount > limit) return false;
      this.run(
        `INSERT INTO quota_ledger(provider, bucket, period_key, used, limit_value, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider, bucket, period_key) DO UPDATE SET
         used=excluded.used, limit_value=excluded.limit_value, updated_at_ms=excluded.updated_at_ms`,
        provider,
        bucket,
        periodKey,
        used + amount,
        limit,
        Date.now(),
      );
      return true;
    });
  }

  getQuotaUsage(provider: string, bucket: string, periodKey: string): { used: number; limit: number } {
    const row = this.get<JsonObject>(
      "SELECT used, limit_value FROM quota_ledger WHERE provider = ? AND bucket = ? AND period_key = ?",
      provider,
      bucket,
      periodKey,
    );
    return { used: row ? asNumber(row.used) : 0, limit: row ? asNumber(row.limit_value) : 0 };
  }

  audit(eventType: string, subjectId: string | undefined, detail: JsonObject) {
    this.run(
      "INSERT INTO audit_events(event_type, subject_id, detail_json, created_at_ms) VALUES (?, ?, ?, ?)",
      eventType,
      subjectId ?? null,
      JSON.stringify(detail),
      Date.now(),
    );
  }

  cleanupExpired(now = Date.now()) {
    const detailCutoff = now - 24 * 60 * 60 * 1000;
    this.run("DELETE FROM transfer_leases WHERE expires_at_ms <= ?", now);
    this.run("DELETE FROM resource_leases WHERE expires_at_ms <= ?", now);
    this.run("DELETE FROM extension_handoffs WHERE expires_at_ms < ? OR claimed_at_ms IS NOT NULL", now);
    this.run(
      `DELETE FROM playlist_snapshots
       WHERE expires_at_ms < ?
       AND NOT EXISTS (
         SELECT 1 FROM transfers AS active_transfer,
         json_each(active_transfer.selected_playlist_ids_json) AS selected
         WHERE CAST(selected.value AS TEXT) = playlist_snapshots.id
         AND (
           active_transfer.state NOT IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')
           OR (active_transfer.completed_at_ms IS NOT NULL AND active_transfer.completed_at_ms >= ?)
         )
       )`,
      now,
      detailCutoff,
    );
    const expired = this.all<JsonObject>(
      `SELECT id, destination_json FROM transfers
       WHERE state IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')
       AND completed_at_ms IS NOT NULL AND completed_at_ms < ?
       AND json_extract(destination_json, '$.rawDetailExpiredAtMs') IS NULL`,
      detailCutoff,
    );
    for (const row of expired) {
      const transferId = String(row.id);
      const destination = parseJson<JsonObject>(row.destination_json, {});
      if (!destination.retainedSummary) {
        const itemStates = this.all<JsonObject>(
          "SELECT state, COUNT(*) AS count FROM transfer_items WHERE transfer_id = ? GROUP BY state",
          transferId,
        );
        const receiptStates = this.all<JsonObject>(
          "SELECT verification_status, COUNT(*) AS count FROM write_receipts WHERE transfer_id = ? GROUP BY verification_status",
          transferId,
        );
        const itemCount = itemStates.reduce((total, value) => total + asNumber(value.count), 0);
        const stateCount = (state: string) => itemStates.find((value) => value.state === state) ? asNumber(itemStates.find((value) => value.state === state)!.count) : 0;
        const receiptCount = (state: string) => receiptStates.find((value) => value.verification_status === state) ? asNumber(receiptStates.find((value) => value.verification_status === state)!.count) : 0;
        const verified = receiptCount("VERIFIED_PROVIDER");
        const manual = receiptCount("USER_CONFIRMED_MANUAL");
        const unverified = receiptCount("WRITE_UNVERIFIED") + receiptCount("WRITE_CONFIRMED_NON_OWNED");
        const errors = stateCount("WRITE_FAILED");
        const skipped = stateCount("SKIPPED_NOT_FOUND") + stateCount("SKIPPED_DUPLICATE");
        destination.retainedSummary = {
          counts: { VERIFIED_PROVIDER: verified, USER_CONFIRMED_MANUAL: manual, UNVERIFIED: unverified, ERROR: errors, SKIPPED: skipped, IN_PROGRESS: Math.max(0, itemCount - verified - manual - unverified - errors - skipped) },
          successful: verified + manual,
          independentlyVerified: verified,
          userConfirmedOnly: manual,
          notCountedAsSuccess: Math.max(0, itemCount - verified - manual),
          totalItems: itemCount,
          disclaimer: "Raw item detail expired after the local support window.",
        };
      }
      delete destination.blueprint;
      delete destination.bindings;
      destination.rawDetailExpiredAtMs = now;
      this.transaction(() => {
        this.run("DELETE FROM write_receipts WHERE transfer_id = ?", transferId);
        this.run("DELETE FROM review_decisions WHERE transfer_item_id IN (SELECT id FROM transfer_items WHERE transfer_id = ?)", transferId);
        this.run("DELETE FROM local_job_journal WHERE transfer_id = ?", transferId);
        this.run("DELETE FROM transfer_items WHERE transfer_id = ?", transferId);
        this.run("DELETE FROM audit_events WHERE subject_id = ?", transferId);
        this.run("UPDATE transfers SET destination_json = ?, write_plan_json = NULL, updated_at_ms = ? WHERE id = ?", JSON.stringify(destination), now, transferId);
      });
    }
  }

  clearHistory() {
    this.transaction(() => {
      this.assertNoLiveLeases();
      this.sqlite.exec("DELETE FROM transfer_leases");
      this.sqlite.exec("DELETE FROM resource_leases");
      this.sqlite.exec("DELETE FROM write_receipts");
      this.sqlite.exec("DELETE FROM review_decisions");
      this.sqlite.exec("DELETE FROM local_job_journal");
      this.sqlite.exec("DELETE FROM transfer_items");
      this.sqlite.exec("DELETE FROM transfers");
      this.sqlite.exec("DELETE FROM playlist_snapshots");
      this.sqlite.exec("DELETE FROM audit_events");
    });
  }

  wipeAll() {
    this.transaction(() => {
      this.assertNoLiveLeases();
      for (const table of [
        "transfer_leases",
        "resource_leases",
        "write_receipts",
        "review_decisions",
        "local_job_journal",
        "transfer_items",
        "transfers",
        "playlist_snapshots",
        "service_connections",
        "extension_handoffs",
        "quota_ledger",
        "audit_events",
        "local_profile",
      ]) {
        this.sqlite.exec(`DELETE FROM ${table}`);
      }
    });
  }

  private assertNoLiveLeases(now = Date.now()): void {
    const activeTransfer = this.get<JsonObject>("SELECT 1 AS active FROM transfer_leases WHERE expires_at_ms > ? LIMIT 1", now);
    const activeResource = this.get<JsonObject>("SELECT 1 AS active FROM resource_leases WHERE expires_at_ms > ? LIMIT 1", now);
    if (activeTransfer || activeResource) throw new Error("ACTIVE_PROVIDER_OPERATION");
  }

  destroyFiles() {
    this.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

declare global {
  var __playlistTransferDatabase: LocalDatabase | undefined;
}

export function getLocalDatabase(): LocalDatabase {
  if (!globalThis.__playlistTransferDatabase) globalThis.__playlistTransferDatabase = new LocalDatabase();
  return globalThis.__playlistTransferDatabase;
}
