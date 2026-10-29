import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { QuotaDatabase } from "./quota.ts";

type Row = Record<string, unknown>;
type Result<T = Row> = { success: true; results: T[]; meta: { changes: number; last_row_id: number; duration: number; rows_read: number; rows_written: number; size_after: number; changed_db: boolean } };

function binding(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return Number(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("Unsupported SQL binding");
}

class SqliteStatement {
  readonly owner: SqliteStore;
  readonly sql: string;
  readonly values: SQLInputValue[];
  constructor(owner: SqliteStore, sql: string, values: SQLInputValue[] = []) { this.owner = owner; this.sql = sql; this.values = values; }
  bind(...values: unknown[]) { return new SqliteStatement(this.owner, this.sql, values.map(binding)); }
  execute<T = Row>(): Result<T> {
    const statement = this.owner.sqlite.prepare(this.sql);
    const reads = statement.columns().length > 0;
    const rows = reads ? statement.all(...this.values) as T[] : [];
    const run = reads ? undefined : statement.run(...this.values);
    return { success: true, results: rows, meta: { changes: Number(run?.changes ?? 0), last_row_id: Number(run?.lastInsertRowid ?? 0),
      duration: 0, rows_read: rows.length, rows_written: Number(run?.changes ?? 0), size_after: 0, changed_db: Boolean(run?.changes) } };
  }
  async all<T = Row>() { return this.execute<T>(); }
  async run<T = Row>() { return this.execute<T>(); }
  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.execute<Row>().results[0];
    if (!row) return null;
    if (column !== undefined) {
      if (!Object.hasOwn(row, column)) throw new Error("SQL column unavailable");
      return row[column] as T;
    }
    return row as T;
  }
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const names = this.owner.sqlite.prepare(this.sql).columns().map(column => column.name);
    const values = this.execute<Row>().results.map(row => names.map(name => row[name]));
    return (options?.columnNames ? [names, ...values] : values) as T[];
  }
}

/** Synchronous SQLite work stays inside a non-interleaving BEGIN IMMEDIATE transaction. */
export class SqliteStore {
  readonly sqlite: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ":memory:") {
      if (!path.isAbsolute(filename)) throw new Error("DATABASE_PATH must be absolute");
      mkdirSync(path.dirname(filename), { recursive: true });
    }
    this.sqlite = new DatabaseSync(filename);
    this.sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
  }
  prepare(sql: string) { return new SqliteStatement(this, sql); }
  async batch<T = Row>(statements: SqliteStatement[]): Promise<Result<T>[]> {
    if (statements.some(statement => !(statement instanceof SqliteStatement) || statement.owner !== this)) throw new Error("Foreign SQL statement");
    return this.transaction(() => statements.map(statement => statement.execute<T>()));
  }
  transaction<T>(work: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.sqlite.exec("COMMIT"); return result; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  get database(): QuotaDatabase { return this as unknown as QuotaDatabase; }
  close() { this.sqlite.close(); }

  migrate(directory: string) {
    this.sqlite.exec(`CREATE TABLE IF NOT EXISTS node_schema_migrations
      (tag TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
    const journal = JSON.parse(readFileSync(path.join(directory, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    for (const entry of journal.entries) {
      if (!/^\d{4}_[a-z0-9_]+$/.test(entry.tag)) throw new Error("Invalid migration tag");
      const sql = readFileSync(path.join(directory, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", "");
      const hash = createHash("sha256").update(sql).digest("hex");
      const existing = this.sqlite.prepare("SELECT sha256 FROM node_schema_migrations WHERE tag=?").get(entry.tag);
      if (existing) {
        if (existing.sha256 !== hash) throw new Error("Applied migration checksum mismatch");
        continue;
      }
      this.transaction(() => {
        this.sqlite.exec(sql);
        this.sqlite.prepare("INSERT INTO node_schema_migrations (tag,sha256,applied_at) VALUES (?,?,?)").run(entry.tag, hash, Date.now());
      });
    }
    this.sqlite.exec(`CREATE TABLE IF NOT EXISTS node_trial_handoff
      (id TEXT PRIMARY KEY CHECK(id='public-preview-trial'), source_sha256 TEXT NOT NULL,
       captured_at TEXT NOT NULL, imported_at INTEGER NOT NULL, initial_reserved_cents INTEGER NOT NULL)`);
  }

  /** Import metadata is an operator attestation, not a remote proof that the old host is off. */
  handoffReady(): boolean {
    try {
      const marker = this.sqlite.prepare("SELECT * FROM node_trial_handoff WHERE id='public-preview-trial'").get();
      const budget = this.sqlite.prepare("SELECT limit_cents,reserved_cents FROM ai_trial_budget WHERE id='public-preview-trial'").get();
      const sum = this.sqlite.prepare("SELECT COALESCE(SUM(reserved_cents),0) AS cents FROM ai_call_reservations").get();
      return !!marker && /^[a-f0-9]{64}$/.test(String(marker.source_sha256)) && !!budget
        && Number.isInteger(budget.limit_cents) && Number(budget.limit_cents) >= 0 && Number(budget.limit_cents) <= 1000
        && Number.isInteger(budget.reserved_cents) && Number(budget.reserved_cents) >= Number(marker.initial_reserved_cents)
        && Number(budget.reserved_cents) <= Number(budget.limit_cents) && budget.reserved_cents === sum?.cents;
    } catch { return false; }
  }
}

const stores = new Map<string, SqliteStore>();
export function configuredSqliteStore(): SqliteStore | undefined {
  const filename = process.env.DATABASE_PATH;
  if (!filename || !path.isAbsolute(filename)) return undefined;
  try {
    let store = stores.get(filename);
    if (!store) {
      store = new SqliteStore(filename);
      // Startup CLI is authoritative; this also makes local development safe.
      try { store.migrate(path.join(process.cwd(), "drizzle")); }
      catch (error) { store.close(); throw error; }
      stores.set(filename, store);
    }
    return store;
  } catch { return undefined; }
}
