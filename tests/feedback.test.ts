import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { FeedbackError, feedbackPseudonym, readFeedbackRequest, submitFeedback, validateFeedbackInput } from "../server/feedback.ts";
import { reserveAiCall } from "../server/quota.ts";
import type { QuotaDatabase } from "../server/quota.ts";

type Binding = string | number | null;
class Statement {
  sql: string;
  values: Binding[] = [];
  constructor(sql: string) { this.sql = sql; }
  bind(...values: Binding[]) { this.values = values; return this; }
}

/** Execute production SQL with D1 batch transaction semantics. */
class SqliteD1 {
  sqlite = new DatabaseSync(":memory:");
  batches = 0;
  failAtStatement = -1;
  loseReplyAfterCommit = false;
  constructor(migrationCount = Number.POSITIVE_INFINITY) {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    for (const entry of this.journal().slice(0, migrationCount)) this.migrate(entry.tag);
  }
  journal(): { tag: string }[] {
    return JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")).entries;
  }
  migrate(tag: string) {
    this.sqlite.exec(readFileSync(new URL(`../drizzle/${tag}.sql`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  prepare(sql: string) { return new Statement(sql); }
  async batch(statements: Statement[]) {
    await Promise.resolve();
    this.batches += 1;
    this.sqlite.exec("BEGIN IMMEDIATE");
    const reports: { success: boolean; results: Record<string, unknown>[] }[] = [];
    try {
      statements.forEach((statement, index) => {
        if (index === this.failAtStatement) throw new Error("Synthetic storage failure");
        const prepared = this.sqlite.prepare(statement.sql);
        if (/^\s*SELECT\b/i.test(statement.sql)) reports.push({ success: true, results: prepared.all(...statement.values) });
        else { prepared.run(...statement.values); reports.push({ success: true, results: [] }); }
      });
      this.sqlite.exec("COMMIT");
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
    if (this.loseReplyAfterCommit) throw new Error("Synthetic lost reply");
    return reports;
  }
  get database() { return this as unknown as QuotaDatabase; }
  count(table: "feedback_messages" | "feedback_submission_guards") {
    return Number(this.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  }
  close() { this.sqlite.close(); }
}

const NOW = new Date("2026-10-29T12:00:00Z");
const DAY_MS = 86_400_000;
const A = "a".repeat(64);
const B = "b".repeat(64);
const SECRET = "synthetic-feedback-test-secret-at-least-32-characters";
const input = (message = "Please add more historical tactical games.") => validateFeedbackInput({ requestId: randomUUID(), category: "missing-game", message });
function request(body: string, headers: HeadersInit = {}) {
  const requestHeaders = new Headers({ Origin: "https://atlas.example", "Content-Type": "application/json" });
  new Headers(headers).forEach((value, name) => requestHeaders.set(name, value));
  return new Request("https://atlas.example/api/feedback", {
    method: "POST", headers: requestHeaders, body,
  });
}
function hasStatus(status: number) { return (error: unknown) => error instanceof FeedbackError && error.status === status; }

test("feedback input preserves plain text while rejecting invalid or unrequested fields", () => {
  const id = randomUUID();
  const valid = validateFeedbackInput({ requestId: id.toUpperCase(), category: "idea", message: "  请增加历史战术游戏，并且展示不同的战术选择和机制。  " });
  assert.equal(valid.requestId, id);
  assert.equal(valid.message, "请增加历史战术游戏，并且展示不同的战术选择和机制。");
  for (const value of [null, [], {}, { ...valid, requestId: "visitor-id" }, { ...valid, category: "contact" },
    { ...valid, message: "x".repeat(19) }, { ...valid, message: "x".repeat(2001) }, { ...valid, email: "private@example.test" }]) {
    assert.throws(() => validateFeedbackInput(value), hasStatus(400));
  }
  assert.equal(input("x".repeat(20)).message.length, 20);
  assert.equal(input("x".repeat(2000)).message.length, 2000);
  assert.equal(input("😀".repeat(20)).message, "😀".repeat(20));
  assert.throws(() => input("😀".repeat(19)), hasStatus(400));
});

test("feedback HTTP parsing rejects cross-origin, non-JSON, malformed and oversized bodies", async () => {
  const body = JSON.stringify(input());
  assert.deepEqual(await readFeedbackRequest(request(body, { "Content-Type": "application/json; charset=utf-8" })), JSON.parse(body));
  await assert.rejects(readFeedbackRequest(request(body, { Origin: "https://other.example" })), hasStatus(403));
  const missingOrigin = request(body); missingOrigin.headers.delete("origin");
  await assert.rejects(readFeedbackRequest(missingOrigin), hasStatus(403));
  await assert.rejects(readFeedbackRequest(request(body, { "Content-Type": "text/plain" })), hasStatus(415));
  await assert.rejects(readFeedbackRequest(request("{")), hasStatus(400));
  // Content-Length is untrusted: a small declaration must not bypass stream size enforcement.
  await assert.rejects(readFeedbackRequest(request("x".repeat(8193), { "Content-Length": "1" })), hasStatus(413));
});

test("feedback pseudonyms are purpose separated and missing configuration fails closed", async () => {
  const hash = await feedbackPseudonym(A, SECRET);
  assert.match(hash ?? "", /^[a-f0-9]{64}$/);
  assert.notEqual(hash, A);
  assert.equal(await feedbackPseudonym(A, SECRET), hash);
  assert.notEqual(await feedbackPseudonym(B, SECRET), hash);
  assert.notEqual(await feedbackPseudonym(A, SECRET + "other"), hash);
  assert.equal(await feedbackPseudonym(undefined, SECRET), undefined);
  assert.equal(await feedbackPseudonym(A, "short"), undefined);
});

test("feedback migration and an accepted message preserve the existing AI ledger", async () => {
  const db = new SqliteD1(3);
  try {
    assert.equal((await reserveAiCall(db.database, randomUUID(), NOW)).allowed, true);
    const tables = ["ai_trial_budget", "ai_call_reservations", "ai_daily_usage", "ai_client_submissions"];
    const before = tables.map((table) => db.sqlite.prepare(`SELECT * FROM ${table}`).all());
    for (const entry of db.journal().slice(3)) db.migrate(entry.tag);
    const body = input("A SQL-like string is feedback: '); DROP TABLE ai_trial_budget; --");
    assert.deepEqual(await submitFeedback(db.database, A, body, NOW), { accepted: true, duplicate: false });
    assert.equal(db.count("feedback_messages"), 1);
    assert.equal(db.count("feedback_submission_guards"), 1);
    assert.equal(db.sqlite.prepare("SELECT message FROM feedback_messages").get()?.message, body.message);
    assert.deepEqual(tables.map((table) => db.sqlite.prepare(`SELECT * FROM ${table}`).all()), before);
  } finally { db.close(); }
});

test("concurrent duplicate feedback is saved once and changed ownership or payload conflicts", async () => {
  const db = new SqliteD1();
  try {
    const body = input();
    const results = await Promise.all(Array.from({ length: 16 }, () => submitFeedback(db.database, A, body, NOW)));
    assert.equal(results.filter((result) => result.accepted && !result.duplicate).length, 1);
    assert.equal(results.filter((result) => result.accepted && result.duplicate).length, 15);
    assert.equal(db.count("feedback_messages"), 1);
    assert.equal(db.count("feedback_submission_guards"), 1);
    assert.deepEqual(await submitFeedback(db.database, B, body, NOW), { accepted: false, reason: "request_conflict" });
    assert.deepEqual(await submitFeedback(db.database, A, { ...body, message: "A different message using an existing request ID." }, NOW), { accepted: false, reason: "request_conflict" });
    assert.equal(db.count("feedback_messages"), 1);
  } finally { db.close(); }
});

test("concurrent feedback cannot exceed three accepted messages per client UTC day", async () => {
  const db = new SqliteD1();
  try {
    const results = await Promise.all(Array.from({ length: 16 }, () => submitFeedback(db.database, A, input(), NOW)));
    assert.equal(results.filter((result) => result.accepted).length, 3);
    assert.equal(results.filter((result) => !result.accepted && result.reason === "client_limit").length, 13);
    assert.equal(db.count("feedback_messages"), 3);
    assert.equal(db.count("feedback_submission_guards"), 3);
    assert.equal((await submitFeedback(db.database, B, input(), NOW)).accepted, true);
  } finally { db.close(); }
});

test("the global daily boundary remains atomic across different client sessions", async () => {
  const db = new SqliteD1();
  try {
    for (let i = 0; i < 199; i++) {
      assert.equal((await submitFeedback(db.database, i.toString(16).padStart(64, "0"), input(), NOW)).accepted, true);
    }
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => submitFeedback(db.database, (i + 1000).toString(16).padStart(64, "0"), input(), NOW)));
    assert.equal(results.filter((result) => result.accepted).length, 1);
    assert.equal(results.filter((result) => !result.accepted && result.reason === "global_limit").length, 15);
    assert.equal(db.count("feedback_messages"), 200);
    assert.equal(db.count("feedback_submission_guards"), 200);
  } finally { db.close(); }
});

test("UTC rollover resets feedback daily limits without retaining old guards indefinitely", async () => {
  const db = new SqliteD1();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await submitFeedback(db.database, A, input(), NOW)).accepted, true);
    assert.equal((await submitFeedback(db.database, A, input(), new Date("2026-10-30T00:00:00Z"))).accepted, true);
    assert.equal(db.count("feedback_submission_guards"), 4);
    assert.equal((await submitFeedback(db.database, A, input(), new Date(NOW.getTime() + DAY_MS + 1))).accepted, true);
    assert.equal(db.count("feedback_submission_guards"), 2);
    assert.equal(db.count("feedback_messages"), 5);
  } finally { db.close(); }
});

test("later submissions remove content older than 90 days while retaining the boundary", async () => {
  const db = new SqliteD1();
  try {
    const expired = input();
    const boundary = input();
    const recent = input();
    assert.equal((await submitFeedback(db.database, A, expired, new Date(NOW.getTime() - 90 * DAY_MS - 1))).accepted, true);
    assert.equal((await submitFeedback(db.database, A, boundary, new Date(NOW.getTime() - 90 * DAY_MS))).accepted, true);
    assert.equal((await submitFeedback(db.database, B, recent, new Date(NOW.getTime() - DAY_MS - 1))).accepted, true);
    assert.equal((await submitFeedback(db.database, B, input(), NOW)).accepted, true);
    assert.equal(db.count("feedback_messages"), 3);
    assert.equal(db.count("feedback_submission_guards"), 1);
    assert.equal(db.sqlite.prepare("SELECT request_id FROM feedback_messages WHERE request_id = ?").get(expired.requestId), undefined);
    assert.equal(db.sqlite.prepare("SELECT request_id FROM feedback_messages WHERE request_id = ?").get(boundary.requestId)?.request_id, boundary.requestId);
    assert.equal(db.sqlite.prepare("SELECT request_id FROM feedback_messages WHERE request_id = ?").get(recent.requestId)?.request_id, recent.requestId);
  } finally { db.close(); }
});

test("storage failures roll back, and lost success replies can be retried idempotently", async () => {
  const db = new SqliteD1();
  try {
    const body = input();
    assert.deepEqual(await submitFeedback(undefined, A, body, NOW), { accepted: false, reason: "feedback_unavailable" });
    assert.deepEqual(await submitFeedback(db.database, undefined, body, NOW), { accepted: false, reason: "feedback_unavailable" });
    assert.equal(db.batches, 0);
    db.failAtStatement = 1;
    assert.deepEqual(await submitFeedback(db.database, A, body, NOW), { accepted: false, reason: "feedback_unavailable" });
    assert.equal(db.count("feedback_messages"), 0);
    assert.equal(db.count("feedback_submission_guards"), 0);
    db.failAtStatement = -1;
    db.loseReplyAfterCommit = true;
    assert.deepEqual(await submitFeedback(db.database, A, body, NOW), { accepted: false, reason: "feedback_unavailable" });
    assert.equal(db.count("feedback_messages"), 1);
    db.loseReplyAfterCommit = false;
    assert.deepEqual(await submitFeedback(db.database, A, body, NOW), { accepted: true, duplicate: true });
    assert.equal(db.count("feedback_messages"), 1);
    assert.equal(db.count("feedback_submission_guards"), 1);
  } finally { db.close(); }
});
