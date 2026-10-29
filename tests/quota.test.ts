import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  reserveAiCall,
  RESERVATION_CENTS,
  TRIAL_LIMIT_CENTS,
  UTC_DAY_CALL_LIMIT,
} from "../server/quota.ts";
import type { QuotaDatabase } from "../server/quota.ts";

type Binding = string | number | null;

class Statement {
  sql: string;
  values: Binding[] = [];
  constructor(sql: string) { this.sql = sql; }
  bind(...values: Binding[]): this { this.values = values; return this; }
}

/** SQLite executes the same SQL, with batch commit/rollback matching D1. */
class SqliteD1 {
  sqlite: DatabaseSync;
  batches = 0;
  failAtStatement = -1;
  loseReplyAfterCommit = false;

  constructor(migrationCount = Number.POSITIVE_INFINITY) {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    for (const entry of journal.entries.slice(0, migrationCount)) this.migrate(entry.tag);
  }

  migrate(tag: string) {
    const migration = readFileSync(new URL(`../drizzle/${tag}.sql`, import.meta.url), "utf8");
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.exec(migration.replaceAll("--> statement-breakpoint", ""));
      this.sqlite.exec("COMMIT");
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }

  prepare(sql: string): Statement { return new Statement(sql); }

  async batch(statements: Statement[]) {
    // Let callers enqueue concurrently before each single batch transaction.
    await Promise.resolve();
    this.batches += 1;
    this.sqlite.exec("BEGIN IMMEDIATE");
    const reports: { success: boolean; results: Record<string, unknown>[] }[] = [];
    try {
      statements.forEach((statement, index) => {
        if (index === this.failAtStatement) throw new Error("Synthetic database failure");
        const prepared = this.sqlite.prepare(statement.sql);
        if (/^\s*SELECT\b/i.test(statement.sql)) {
          const rows = prepared.all(...statement.values);
          reports.push({ success: true, results: rows });
        } else {
          prepared.run(...statement.values);
          reports.push({ success: true, results: [] });
        }
      });
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    if (this.loseReplyAfterCommit) throw new Error("Synthetic lost reply");
    return reports;
  }

  get database(): QuotaDatabase { return this as unknown as QuotaDatabase; }
  count(sql: string): number {
    return Number(this.sqlite.prepare(sql).get()?.value ?? 0);
  }
  close() { this.sqlite.close(); }
}

const DAY = new Date("2026-10-29T12:00:00Z");

test("one DeepSeek reservation consumes three cents and one UTC-day call", async () => {
  const db = new SqliteD1();
  try {
    const id = randomUUID();
    assert.deepEqual(await reserveAiCall(db.database, id, DAY), {
      allowed: true, requestId: id, reservedCents: RESERVATION_CENTS,
    });
    assert.equal(db.count("SELECT reserved_cents AS value FROM ai_trial_budget"), RESERVATION_CENTS);
    assert.equal(db.count("SELECT reserved_calls AS value FROM ai_daily_usage"), 1);
    assert.equal(db.count("SELECT count(*) AS value FROM ai_call_reservations WHERE state = 'reserved'"), 1);
  } finally { db.close(); }
});

test("concurrent duplicate deliveries authorize exactly one upstream call", async () => {
  const db = new SqliteD1();
  try {
    const id = randomUUID();
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => reserveAiCall(db.database, id, DAY)));
    assert.equal(outcomes.filter((result) => result.allowed).length, 1);
    assert.equal(outcomes.filter((result) => !result.allowed && result.reason === "duplicate_request").length, 19);
    assert.equal(db.count("SELECT reserved_cents AS value FROM ai_trial_budget"), RESERVATION_CENTS);
    assert.equal(db.count("SELECT reserved_calls AS value FROM ai_daily_usage"), 1);
    assert.deepEqual(await reserveAiCall(db.database, id.toUpperCase(), DAY), {
      allowed: false, reason: "duplicate_request",
    });
  } finally { db.close(); }
});

test("concurrent requests at the trial boundary cannot exceed US$10", async () => {
  const db = new SqliteD1();
  try {
    await reserveAiCall(db.database, randomUUID(), DAY);
    db.sqlite.exec(`UPDATE ai_trial_budget SET reserved_cents = ${TRIAL_LIMIT_CENTS - RESERVATION_CENTS}`);
    const outcomes = await Promise.all(Array.from({ length: 30 }, () => reserveAiCall(db.database, randomUUID(), DAY)));
    assert.equal(outcomes.filter((result) => result.allowed).length, 1);
    assert.equal(outcomes.filter((result) => !result.allowed && result.reason === "trial_exhausted").length, 29);
    assert.equal(db.count("SELECT reserved_cents AS value FROM ai_trial_budget"), TRIAL_LIMIT_CENTS);
    const nextDay = new Date("2026-10-30T00:00:01Z");
    assert.deepEqual(await reserveAiCall(db.database, randomUUID(), nextDay), {
      allowed: false, reason: "trial_exhausted",
    });
    assert.equal(db.count("SELECT reserved_cents AS value FROM ai_trial_budget"), TRIAL_LIMIT_CENTS);
  } finally { db.close(); }
});

test("daily boundary is atomic and UTC rollover does not reset lifetime budget", async () => {
  const db = new SqliteD1();
  try {
    await reserveAiCall(db.database, randomUUID(), DAY);
    db.sqlite.exec(`UPDATE ai_daily_usage SET reserved_calls = ${UTC_DAY_CALL_LIMIT - 1}`);
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => reserveAiCall(db.database, randomUUID(), DAY)));
    assert.equal(outcomes.filter((result) => result.allowed).length, 1);
    assert.equal(outcomes.filter((result) => !result.allowed && result.reason === "daily_limit").length, 11);
    assert.equal(db.count("SELECT reserved_calls AS value FROM ai_daily_usage WHERE day_key = '2026-10-29'"), 100);
    const nextDay = new Date("2026-10-30T00:00:00Z");
    assert.equal((await reserveAiCall(db.database, randomUUID(), nextDay)).allowed, true);
    assert.equal(db.count("SELECT reserved_cents AS value FROM ai_trial_budget"), RESERVATION_CENTS * 3);
    assert.equal(db.count("SELECT reserved_calls AS value FROM ai_daily_usage WHERE day_key = '2026-10-30'"), 1);
  } finally { db.close(); }
});

test("invalid IDs and missing storage fail closed without creating reservations", async () => {
  const db = new SqliteD1();
  try {
    for (const id of ["", "request-1", "../secret", "a".repeat(10_000)]) {
      assert.deepEqual(await reserveAiCall(db.database, id, DAY), {
        allowed: false, reason: "invalid_request_id",
      });
    }
    assert.equal(db.batches, 0);
    assert.deepEqual(await reserveAiCall(undefined, randomUUID(), DAY), {
      allowed: false, reason: "quota_unavailable",
    });
    assert.equal(db.count("SELECT count(*) AS value FROM ai_call_reservations"), 0);
  } finally { db.close(); }
});

test("batch failure rolls back a partially changed budget and denies dispatch", async () => {
  const db = new SqliteD1();
  try {
    db.failAtStatement = 5; // After lifetime reservation but before daily update.
    assert.deepEqual(await reserveAiCall(db.database, randomUUID(), DAY), {
      allowed: false, reason: "quota_unavailable",
    });
    assert.equal(db.count("SELECT count(*) AS value FROM ai_trial_budget"), 0);
    assert.equal(db.count("SELECT count(*) AS value FROM ai_call_reservations"), 0);
  } finally { db.close(); }
});

test("lost post-commit reply leaves a non-refundable reservation and no duplicate dispatch", async () => {
  const db = new SqliteD1();
  try {
    const id = randomUUID();
    db.loseReplyAfterCommit = true;
    assert.deepEqual(await reserveAiCall(db.database, id, DAY), {
      allowed: false, reason: "quota_unavailable",
    });
    db.loseReplyAfterCommit = false;
    assert.deepEqual(await reserveAiCall(db.database, id, DAY), {
      allowed: false, reason: "duplicate_request",
    });
    assert.equal(db.count("SELECT reserved_cents AS value FROM ai_trial_budget"), RESERVATION_CENTS);
    assert.equal(db.count("SELECT reserved_calls AS value FROM ai_daily_usage"), 1);
  } finally { db.close(); }
});

test("migration preserves the three legacy cents, reservation IDs, daily usage and throttle indexes", async () => {
  const db = new SqliteD1(2);
  try {
    db.sqlite.exec(`INSERT INTO ai_trial_budget VALUES ('public-preview-trial', 1000, 3);
      INSERT INTO ai_daily_usage VALUES ('2026-10-29', 100, 3);
      INSERT INTO ai_client_submissions VALUES ('throttle-fixture', '${"a".repeat(64)}', '2026-10-29', ${DAY.getTime()});`);
    const legacyIds = Array.from({ length: 3 }, () => randomUUID());
    for (const id of legacyIds) {
      db.sqlite.prepare(`INSERT INTO ai_call_reservations
        (request_id, owner_nonce, day_key, state, reserved_cents, denial_reason, config_version, created_at)
        VALUES (?, ?, '2026-10-29', 'reserved', 1, NULL, 'trial-v1', ?)`)
        .run(id, randomUUID(), DAY.getTime());
    }
    const legacyRows = db.sqlite.prepare("SELECT * FROM ai_call_reservations ORDER BY request_id").all();
    const oldIndexes = db.sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'ai_client_submissions' AND type = 'index' ORDER BY name").all();
    const oldThrottleRows = db.sqlite.prepare("SELECT * FROM ai_client_submissions").all();
    assert.throws(() => db.sqlite.exec("UPDATE ai_call_reservations SET reserved_cents = 3"), /CHECK constraint failed/);

    // The actual shipped SQL runs transactionally with foreign keys enabled,
    // matching D1's constraint enforcement rather than masking migration risks.
    db.migrate("0002_deepseek_reservation_unit");
    assert.deepEqual(db.sqlite.prepare("SELECT * FROM ai_call_reservations ORDER BY request_id").all(), legacyRows);
    assert.equal(db.count("SELECT reserved_cents AS value FROM ai_trial_budget"), 3);
    assert.equal(db.count("SELECT reserved_calls AS value FROM ai_daily_usage"), 3);
    assert.deepEqual(db.sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'ai_client_submissions' AND type = 'index' ORDER BY name").all(), oldIndexes);
    assert.deepEqual(db.sqlite.prepare("SELECT * FROM ai_client_submissions").all(), oldThrottleRows);
    assert.equal(db.sqlite.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
    assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.sqlite.prepare("PRAGMA foreign_key_list(ai_call_reservations)").get()?.table, "ai_daily_usage");

    for (const id of legacyIds) {
      assert.deepEqual(await reserveAiCall(db.database, id, DAY), { allowed: false, reason: "duplicate_request" });
    }
    const freshId = randomUUID();
    assert.deepEqual(await reserveAiCall(db.database, freshId, DAY), {
      allowed: true, requestId: freshId, reservedCents: 3,
    });
    assert.equal(db.count("SELECT reserved_cents AS value FROM ai_trial_budget"), 6);
    assert.equal(db.count("SELECT reserved_calls AS value FROM ai_daily_usage"), 4);
    assert.equal(db.sqlite.prepare("SELECT config_version FROM ai_call_reservations WHERE request_id = ?").get(freshId)?.config_version, "deepseek-v1");
    assert.deepEqual(db.sqlite.prepare("SELECT * FROM ai_call_reservations WHERE config_version = 'trial-v1' ORDER BY request_id").all(), legacyRows);
    assert.throws(() => db.sqlite.prepare("UPDATE ai_call_reservations SET reserved_cents = 4 WHERE request_id = ?").run(freshId), /CHECK constraint failed/);
  } finally { db.close(); }
});

test("one or two remaining cents cannot fund a three-cent call", async () => {
  for (const remaining of [1, 2]) {
    const db = new SqliteD1();
    try {
      await reserveAiCall(db.database, randomUUID(), DAY);
      const reserved = TRIAL_LIMIT_CENTS - remaining;
      db.sqlite.exec(`UPDATE ai_trial_budget SET reserved_cents = ${reserved}`);
      assert.deepEqual(await reserveAiCall(db.database, randomUUID(), DAY), { allowed: false, reason: "trial_exhausted" });
      assert.equal(db.count("SELECT reserved_cents AS value FROM ai_trial_budget"), reserved);
      assert.equal(db.count("SELECT reserved_calls AS value FROM ai_daily_usage"), 1);
    } finally { db.close(); }
  }
});
