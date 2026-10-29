import { createHash } from "node:crypto";
import type { SqliteStore } from "./sqlite-store.ts";

const TRIAL = "public-preview-trial";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const COLUMNS = {
  ai_trial_budget: ["id", "limit_cents", "reserved_cents"],
  ai_daily_usage: ["day_key", "call_limit", "reserved_calls"],
  ai_call_reservations: ["request_id", "owner_nonce", "day_key", "state", "reserved_cents", "denial_reason", "config_version", "created_at"],
  ai_client_submissions: ["attempt_id", "client_hash", "day_key", "created_at"],
} as const;
type Table = keyof typeof COLUMNS;
type Row = Record<string, string | number | null>;
export type LedgerSnapshot = {
  schemaVersion: 1; source: "tactical-atlas-sites"; capturedAt: string; sourceAiDisabled: true;
  tables: Record<Table, Row[]>;
};
function reject(): never { throw new Error("Invalid ledger handoff; no data imported"); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function integer(value: unknown, low: number, high: number) {
  return Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high;
}
function day(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function timestamp(value: unknown, dayKey: unknown, captured: number) {
  return integer(value, 0, captured) && day(dayKey) && new Date(Number(value)).toISOString().slice(0, 10) === dayKey;
}

/** A bounded, explicit four-table handoff; no queries, feedback, keys or other fields are accepted. */
export function validateLedgerSnapshot(value: unknown, now = Date.now()): LedgerSnapshot {
  if (!Number.isSafeInteger(now) || !exact(value, ["schemaVersion", "source", "capturedAt", "sourceAiDisabled", "tables"])
    || value.schemaVersion !== 1 || value.source !== "tactical-atlas-sites" || value.sourceAiDisabled !== true
    || typeof value.capturedAt !== "string" || !value.capturedAt.endsWith("Z")) reject();
  const captured = Date.parse(value.capturedAt);
  // A cutover snapshot must be fresh; the old host must already be disabled.
  // This assertion is checked operationally by the owner, not by this file.
  if (!Number.isFinite(captured) || captured > now + 60_000 || now - captured > 3_600_000 || !exact(value.tables, Object.keys(COLUMNS))) reject();
  const tables = value.tables as unknown as Record<Table, Row[]>;
  for (const name of Object.keys(COLUMNS) as Table[]) {
    const rows = tables[name];
    if (!Array.isArray(rows) || rows.length > 10_000 || rows.some(row => !exact(row, COLUMNS[name])
      || Object.values(row).some(value => value !== null && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))))) reject();
    const primary = COLUMNS[name][0];
    if (new Set(rows.map(row => row[primary])).size !== rows.length) reject();
  }
  const [budget] = tables.ai_trial_budget;
  if (tables.ai_trial_budget.length !== 1 || budget.id !== TRIAL || !integer(budget.limit_cents, 0, 1000)
    || !integer(budget.reserved_cents, 0, Number(budget.limit_cents))) reject();
  const days = new Map<string, Row>();
  for (const row of tables.ai_daily_usage) {
    if (!day(row.day_key) || !integer(row.call_limit, 0, 100) || !integer(row.reserved_calls, 0, Number(row.call_limit))) reject();
    days.set(row.day_key, row);
  }
  let cents = 0;
  const calls = new Map<string, number>();
  for (const row of tables.ai_call_reservations) {
    if (typeof row.request_id !== "string" || !UUID.test(row.request_id) || typeof row.owner_nonce !== "string" || !UUID.test(row.owner_nonce)
      || !day(row.day_key) || !days.has(row.day_key) || !timestamp(row.created_at, row.day_key, captured)
      || !["trial-v1", "deepseek-v1"].includes(String(row.config_version))) reject();
    if (row.state === "reserved") {
      if (row.reserved_cents !== (row.config_version === "trial-v1" ? 1 : 3) || row.denial_reason !== null) reject();
      cents += Number(row.reserved_cents); calls.set(row.day_key, (calls.get(row.day_key) ?? 0) + 1);
    } else if (row.state === "denied") {
      if (row.reserved_cents !== 0 || !["trial_exhausted", "daily_limit", "quota_unavailable"].includes(String(row.denial_reason))) reject();
    } else if (row.state === "pending") {
      if (row.reserved_cents !== 0 || row.denial_reason !== null) reject();
    } else reject();
  }
  if (cents !== budget.reserved_cents || [...days].some(([key, row]) => row.reserved_calls !== (calls.get(key) ?? 0))) reject();
  for (const row of tables.ai_client_submissions) {
    if (typeof row.attempt_id !== "string" || !UUID.test(row.attempt_id) || typeof row.client_hash !== "string" || !HASH.test(row.client_hash)
      || !timestamp(row.created_at, row.day_key, captured)) reject();
  }
  return value as unknown as LedgerSnapshot;
}

export function importLedgerSnapshot(store: SqliteStore, value: unknown, now = Date.now()) {
  const snapshot = validateLedgerSnapshot(value, now);
  // Canonical column/table order makes equivalent exports produce one marker.
  const canonical = JSON.stringify({ schemaVersion: snapshot.schemaVersion, source: snapshot.source,
    capturedAt: snapshot.capturedAt, sourceAiDisabled: snapshot.sourceAiDisabled,
    tables: Object.fromEntries((Object.keys(COLUMNS) as Table[]).map(name => [name,
    snapshot.tables[name].map(row => Object.fromEntries(COLUMNS[name].map(column => [column, row[column]])))
      .sort((a, b) => String(a[COLUMNS[name][0]]).localeCompare(String(b[COLUMNS[name][0]]))),
  ])) });
  const hash = createHash("sha256").update(canonical).digest("hex");
  return store.transaction(() => {
    const marker = store.sqlite.prepare("SELECT source_sha256 FROM node_trial_handoff WHERE id=?").get(TRIAL);
    if (marker) {
      if (marker.source_sha256 !== hash || !store.handoffReady()) reject();
      return { imported: false, alreadyImported: true, reservedCents: Number(store.sqlite.prepare("SELECT reserved_cents FROM ai_trial_budget WHERE id=?").get(TRIAL)?.reserved_cents) };
    }
    for (const name of Object.keys(COLUMNS) as Table[]) {
      if (Number(store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()?.n) !== 0) reject();
    }
    for (const name of ["ai_trial_budget", "ai_daily_usage", "ai_call_reservations", "ai_client_submissions"] as Table[]) {
      const columns = COLUMNS[name];
      const statement = store.sqlite.prepare(`INSERT INTO ${name} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of snapshot.tables[name]) statement.run(...columns.map(column => row[column]));
    }
    const reserved = Number(snapshot.tables.ai_trial_budget[0].reserved_cents);
    store.sqlite.prepare("INSERT INTO node_trial_handoff (id,source_sha256,captured_at,imported_at,initial_reserved_cents) VALUES (?,?,?,?,?)")
      .run(TRIAL, hash, snapshot.capturedAt, now, reserved);
    if (!store.handoffReady()) reject();
    return { imported: true, alreadyImported: false, reservedCents: reserved };
  });
}
