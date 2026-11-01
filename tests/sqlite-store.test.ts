import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteStore, configuredSqliteStore } from "../server/sqlite-store.ts";
import { importLedgerSnapshot, validateLedgerSnapshot } from "../server/ledger-handoff.ts";
import type { LedgerSnapshot } from "../server/ledger-handoff.ts";
import { reserveAiCall } from "../server/quota.ts";
import { submitFeedback, readFeedbackRequest, FeedbackError } from "../server/feedback.ts";
import { aiRuntime } from "../server/runtime.ts";

const NOW = new Date("2026-10-29T12:00:00Z");
const migrations = path.resolve("drizzle");
function open() { const store = new SqliteStore(":memory:"); store.migrate(migrations); return store; }
function fixture(): LedgerSnapshot {
  const rows = Array.from({ length: 9 }, (_, i) => ({ request_id: randomUUID(), owner_nonce: randomUUID(), day_key: "2026-10-29",
    state: "reserved", reserved_cents: i < 3 ? 1 : 3, denial_reason: null, config_version: i < 3 ? "trial-v1" : "deepseek-v1", created_at: NOW.getTime() - 1000 }));
  return { schemaVersion: 1, source: "tactical-atlas-sites", sourceAiDisabled: true, capturedAt: NOW.toISOString(), tables: {
    ai_trial_budget: [{ id: "public-preview-trial", limit_cents: 1000, reserved_cents: 21 }],
    ai_daily_usage: [{ day_key: "2026-10-29", call_limit: 100, reserved_calls: 9 }],
    ai_call_reservations: rows,
    ai_client_submissions: [{ attempt_id: randomUUID(), client_hash: "a".repeat(64), day_key: "2026-10-29", created_at: NOW.getTime() - 1000 }],
  } };
}
function count(store: SqliteStore, table: string) { return Number(store.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n); }
function removeTestDirectory(directory: string) {
  const target = realpathSync(directory);
  const relative = path.relative(realpathSync(os.tmpdir()), target);
  if (path.dirname(relative) !== "." || !/^atlas-(sqlite|runtime)-test-[a-z0-9]+$/i.test(relative)) throw new Error("Unexpected test directory");
  rmSync(target, { recursive: true, force: true });
}

test("Node migrations are idempotent and a fresh database cannot enable AI", () => {
  const store = open();
  try {
    assert.equal(count(store, "node_schema_migrations"), 4);
    assert.equal(count(store, "ai_trial_budget"), 0);
    assert.equal(store.handoffReady(), false);
    store.migrate(migrations);
    assert.equal(count(store, "node_schema_migrations"), 4);
    assert.equal(count(store, "ai_trial_budget"), 0);
  } finally { store.close(); }
});

test("validated handoff preserves all four tables and duplicate import never refunds later calls", async () => {
  const store = open();
  try {
    const snapshot = fixture();
    assert.deepEqual(importLedgerSnapshot(store, snapshot, NOW.getTime()), { imported: true, alreadyImported: false, reservedCents: 21 });
    assert.equal(store.handoffReady(), true);
    for (const [table, rows] of Object.entries(snapshot.tables)) {
      const sorted = (values: object[]) => values.map(value => JSON.stringify(value)).sort();
      assert.deepEqual(sorted(store.sqlite.prepare(`SELECT * FROM ${table}`).all()), sorted(rows));
    }
    assert.deepEqual(await reserveAiCall(store.database, String(snapshot.tables.ai_call_reservations[0].request_id), NOW), { allowed: false, reason: "duplicate_request" });
    assert.equal((await reserveAiCall(store.database, randomUUID(), NOW)).allowed, true);
    assert.deepEqual(importLedgerSnapshot(store, snapshot, NOW.getTime() + 1000), { imported: false, alreadyImported: true, reservedCents: 24 });
    assert.equal(store.handoffReady(), true);
  } finally { store.close(); }
});

test("handoff rejects extra/private fields, stale captures, malformed IDs and mismatched money/call counts", () => {
  const mutations: ((s: LedgerSnapshot) => void)[] = [
    s => { (s as unknown as Record<string, unknown>).feedback = "Private text"; },
    s => { (s.tables as unknown as Record<string, unknown>).feedback_messages = []; },
    s => { s.tables.ai_trial_budget[0].reserved_cents = 18; },
    s => { s.tables.ai_trial_budget[0].limit_cents = 1001; },
    s => { s.tables.ai_daily_usage[0].reserved_calls = 8; },
    s => { s.tables.ai_call_reservations[0].request_id = "not-a-uuid"; },
    s => { s.tables.ai_call_reservations.push({ ...s.tables.ai_call_reservations[0] }); },
    s => { s.tables.ai_call_reservations[0].day_key = "2026-10-28"; },
    s => { s.tables.ai_client_submissions[0].client_hash = "raw-address"; },
    s => { (s as unknown as Record<string, unknown>).sourceAiDisabled = false; },
    s => { s.capturedAt = new Date(NOW.getTime() - 3_600_001).toISOString(); },
    s => { s.capturedAt = new Date(NOW.getTime() + 60_001).toISOString(); },
  ];
  for (const change of mutations) {
    const store = open();
    try {
      const snapshot = fixture(); change(snapshot);
      assert.throws(() => importLedgerSnapshot(store, snapshot, NOW.getTime()));
      assert.equal(count(store, "ai_trial_budget"), 0);
      assert.equal(count(store, "node_trial_handoff"), 0);
    } finally { store.close(); }
  }
});

test("handoff rejects a populated destination and rollback leaves no partial imported allowance", () => {
  const store = open();
  try {
    store.sqlite.exec("CREATE TRIGGER reject_import BEFORE INSERT ON ai_call_reservations BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    assert.throws(() => importLedgerSnapshot(store, fixture(), NOW.getTime()));
    assert.equal(count(store, "ai_trial_budget"), 0);
    assert.equal(count(store, "ai_daily_usage"), 0);
    assert.equal(count(store, "node_trial_handoff"), 0);
    store.sqlite.exec("DROP TRIGGER reject_import; INSERT INTO ai_trial_budget VALUES ('public-preview-trial',1000,0)");
    assert.throws(() => importLedgerSnapshot(store, fixture(), NOW.getTime()));
    assert.equal(store.sqlite.prepare("SELECT reserved_cents FROM ai_trial_budget").get()?.reserved_cents, 0);
    assert.equal(store.handoffReady(), false);
  } finally { store.close(); }
});

test("SQLite transactions preserve the final trial boundary under concurrent reservation attempts", async () => {
  const store = open();
  try {
    importLedgerSnapshot(store, fixture(), NOW.getTime());
    // Lowering the approved limit is allowed and leaves space for exactly one call.
    store.sqlite.exec("UPDATE ai_trial_budget SET limit_cents=24");
    const result = await Promise.all(Array.from({ length: 12 }, () => reserveAiCall(store.database, randomUUID(), NOW)));
    assert.equal(result.filter(value => value.allowed).length, 1);
    assert.equal(store.sqlite.prepare("SELECT reserved_cents FROM ai_trial_budget").get()?.reserved_cents, 24);
    assert.equal(store.handoffReady(), true);
    const before = count(store, "ai_trial_budget");
    await assert.rejects(store.batch([store.prepare("UPDATE ai_trial_budget SET reserved_cents=0"), store.prepare("INSERT INTO missing_table VALUES (1)")]));
    assert.equal(count(store, "ai_trial_budget"), before);
    assert.equal(store.sqlite.prepare("SELECT reserved_cents FROM ai_trial_budget").get()?.reserved_cents, 24);
  } finally { store.close(); }
});

test("file persistence survives restart and marker checks fail closed on counter corruption", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "atlas-sqlite-test-"));
  const filename = path.join(directory, "atlas.sqlite");
  let store = new SqliteStore(filename);
  try {
    store.migrate(migrations); importLedgerSnapshot(store, fixture(), NOW.getTime()); store.close();
    store = new SqliteStore(filename); store.migrate(migrations);
    assert.equal(store.handoffReady(), true);
    assert.equal(store.sqlite.prepare("SELECT reserved_cents FROM ai_trial_budget").get()?.reserved_cents, 21);
    store.sqlite.exec("UPDATE ai_trial_budget SET reserved_cents=18");
    assert.equal(store.handoffReady(), false);
  } finally { store.close(); removeTestDirectory(directory); }
});

test("feedback on the Node adapter is idempotent and never initializes or charges the AI trial", async () => {
  const store = open();
  try {
    const body = { requestId: randomUUID(), category: "idea" as const, message: "Synthetic feedback on an independent host." };
    assert.deepEqual(await submitFeedback(store.database, "a".repeat(64), body, NOW), { accepted: true, duplicate: false });
    assert.deepEqual(await submitFeedback(store.database, "a".repeat(64), body, NOW), { accepted: true, duplicate: true });
    assert.equal(count(store, "feedback_messages"), 1);
    assert.equal(count(store, "ai_trial_budget"), 0);
    assert.equal(count(store, "ai_call_reservations"), 0);
    assert.equal(store.handoffReady(), false);
  } finally { store.close(); }
});

test("trusted HTTPS feedback origin works behind an internal HTTP proxy and forwarded headers are ignored", async () => {
  const payload = JSON.stringify({ requestId: randomUUID(), category: "idea", message: "A useful synthetic feedback message." });
  const request = (origin: string) => new Request("http://container:3000/api/feedback", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "https" }, body: payload,
  });
  assert.equal((await readFeedbackRequest(request("https://atlas.example"), "https://atlas.example", true)).category, "idea");
  const rejected = (error: unknown) => error instanceof FeedbackError && error.status === 403;
  await assert.rejects(readFeedbackRequest(request("https://attacker.example"), "https://atlas.example", true), rejected);
  for (const origin of [undefined, "http://atlas.example", "https://atlas.example/path", "https://atlas.example/", "https://user:password@atlas.example"]) {
    await assert.rejects(readFeedbackRequest(request("https://atlas.example"), origin, true), rejected);
  }
});

test("runtime cannot enable AI on an empty Node store or a spoofable ingress identity mode", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "atlas-runtime-test-"));
  const names = ["DATABASE_PATH", "AI_ENABLED", "AI_THROTTLE_SECRET", "DEEPSEEK_API_KEY", "AI_BILLING_CURRENCY", "AI_CLIENT_IDENTITY_MODE"];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  try {
    process.env.DATABASE_PATH = path.join(directory, "atlas.sqlite");
    process.env.AI_ENABLED = "true"; process.env.AI_THROTTLE_SECRET = "synthetic-secret-at-least-32-characters";
    process.env.DEEPSEEK_API_KEY = "synthetic-not-a-real-provider-key"; process.env.AI_BILLING_CURRENCY = "CNY";
    process.env.AI_CLIENT_IDENTITY_MODE = "browser-session";
    assert.equal(aiRuntime(NOW.getTime()).enabled, false);
    assert.equal(aiRuntime(NOW.getTime()).configurationCode, "LEDGER_HANDOFF_REQUIRED");
    const store = configuredSqliteStore()!;
    importLedgerSnapshot(store, fixture(), NOW.getTime());
    assert.equal(aiRuntime(NOW.getTime()).enabled, true);
    process.env.AI_CLIENT_IDENTITY_MODE = "sites-user";
    assert.equal(aiRuntime(NOW.getTime()).enabled, false);
    process.env.AI_CLIENT_IDENTITY_MODE = "cloudflare-ip";
    assert.equal(aiRuntime(NOW.getTime()).enabled, false);
    store.close();
  } finally {
    for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    removeTestDirectory(directory);
  }
});

test("snapshot validator admits reduced limits but cannot silently widen the trial", () => {
  const value = fixture(); value.tables.ai_trial_budget[0].limit_cents = 21;
  assert.equal(validateLedgerSnapshot(value, NOW.getTime()), value);
  value.tables.ai_trial_budget[0].limit_cents = 20;
  assert.throws(() => validateLedgerSnapshot(value, NOW.getTime()));
});

test("Node startup and handoff CLIs operate on a synthetic persistent database without resetting it", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "atlas-sqlite-test-"));
  try {
    const filename = path.join(directory, "atlas.sqlite");
    const snapshotFile = path.join(directory, "synthetic-ledger.json");
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_PATH: filename, NODE_ENV: "test" as const };
    const run = (script: string, ...args: string[]) => JSON.parse(execFileSync(process.execPath,
      ["--experimental-strip-types", script, ...args], { cwd: process.cwd(), env, encoding: "utf8", windowsHide: true }));
    assert.deepEqual(run("scripts/node-migrate.mjs"), { schemaReady: true, ledgerHandoffReady: false });
    const snapshot = fixture();
    const captured = Date.now();
    const today = new Date(captured).toISOString().slice(0, 10);
    snapshot.capturedAt = new Date(captured).toISOString();
    snapshot.tables.ai_daily_usage[0].day_key = today;
    for (const row of [...snapshot.tables.ai_call_reservations, ...snapshot.tables.ai_client_submissions]) {
      row.day_key = today; row.created_at = captured;
    }
    writeFileSync(snapshotFile, JSON.stringify(snapshot), "utf8");
    assert.deepEqual(run("scripts/node-import-ledger.mjs", snapshotFile), { imported: true, alreadyImported: false, reservedCents: 21 });
    assert.deepEqual(run("scripts/node-migrate.mjs"), { schemaReady: true, ledgerHandoffReady: true });
    assert.deepEqual(run("scripts/node-import-ledger.mjs", snapshotFile), { imported: false, alreadyImported: true, reservedCents: 21 });
  } finally { removeTestDirectory(directory); }
});
