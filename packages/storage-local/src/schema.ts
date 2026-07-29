export const SCHEMA_VERSION = 3;

export const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS local_profile (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    language TEXT NOT NULL CHECK(language IN ('ru', 'en')),
    salt_b64 TEXT NOT NULL,
    verifier TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS service_connections (
    provider TEXT PRIMARY KEY CHECK(provider IN ('spotify', 'soundcloud', 'youtube')),
    account_id TEXT,
    account_label TEXT NOT NULL,
    profile_url TEXT,
    strategy TEXT NOT NULL CHECK(strategy IN ('guided', 'api')),
    status TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    encrypted_secret TEXT,
    authorized_at_ms INTEGER,
    expires_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS playlist_snapshots (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_playlist_id TEXT,
    provider_url TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    owner_label TEXT NOT NULL,
    eligibility TEXT NOT NULL,
    eligibility_evidence_json TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    partial INTEGER NOT NULL DEFAULT 0,
    source_version TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transfers (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    source_provider TEXT NOT NULL,
    destination_provider TEXT NOT NULL,
    mode TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    selected_playlist_ids_json TEXT NOT NULL,
    destination_json TEXT NOT NULL,
    write_plan_json TEXT,
    limitation_codes_json TEXT NOT NULL,
    error_code TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS transfer_leases (
    transfer_id TEXT PRIMARY KEY REFERENCES transfers(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS resource_leases (
    resource_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transfer_items (
    id TEXT PRIMARY KEY,
    transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    source_playlist_id TEXT NOT NULL,
    source_position INTEGER NOT NULL,
    state TEXT NOT NULL,
    source_ref_json TEXT NOT NULL,
    hypotheses_json TEXT NOT NULL,
    candidates_json TEXT NOT NULL,
    decision_json TEXT,
    selected_target_json TEXT,
    idempotency_key TEXT,
    risk_flags_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE(transfer_id, source_playlist_id, source_position)
  )`,
  `CREATE TABLE IF NOT EXISTS review_decisions (
    transfer_item_id TEXT PRIMARY KEY REFERENCES transfer_items(id) ON DELETE CASCADE,
    decision_json TEXT NOT NULL,
    actor TEXT NOT NULL,
    decided_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS write_receipts (
    id TEXT PRIMARY KEY,
    transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    transfer_item_id TEXT NOT NULL REFERENCES transfer_items(id) ON DELETE CASCADE,
    destination_playlist_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    execution_status TEXT NOT NULL,
    verification_status TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    risky INTEGER NOT NULL DEFAULT 0,
    manual INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    UNIQUE(idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS local_job_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    step_kind TEXT NOT NULL,
    step_key TEXT NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE(transfer_id, step_key)
  )`,
  `CREATE TABLE IF NOT EXISTS extension_handoffs (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    checksum TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    claimed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS quota_ledger (
    provider TEXT NOT NULL,
    bucket TEXT NOT NULL,
    period_key TEXT NOT NULL,
    used INTEGER NOT NULL,
    limit_value INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY(provider, bucket, period_key)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    subject_id TEXT,
    detail_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_transfers_updated ON transfers(updated_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_transfer_leases_expiry ON transfer_leases(expires_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_resource_leases_expiry ON resource_leases(expires_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_items_transfer_state ON transfer_items(transfer_id, state)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_transfer_sequence ON local_job_journal(transfer_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS idx_receipts_transfer ON write_receipts(transfer_id)`,
];
