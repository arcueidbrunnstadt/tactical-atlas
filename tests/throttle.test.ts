import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { clientPseudonym, consumeClientSubmission, resolveThrottleClient, SESSION_COOKIE_NAME, CLIENT_DAY_LIMIT } from "../server/throttle.ts";
import type { QuotaDatabase } from "../server/quota.ts";

type Binding = string | number | null;
class Statement {
  sql: string;
  values: Binding[] = [];
  constructor(sql: string) { this.sql = sql; }
  bind(...values: Binding[]) { this.values = values; return this; }
}
class SqliteD1 {
  sqlite = new DatabaseSync(":memory:");
  batches = 0;
  failAtStatement = -1;
  loseReplyAfterCommit = false;
  constructor() {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    const migrations = new URL("../drizzle/", import.meta.url);
    for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(new URL(file, migrations), "utf8").replaceAll("--> statement-breakpoint", ""));
    }
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
  count() { return Number(this.sqlite.prepare("SELECT count(*) AS n FROM ai_client_submissions").get()?.n); }
  close() { this.sqlite.close(); }
}
const NOW = new Date("2026-10-29T12:00:00Z");
const A = "a".repeat(64);
const B = "b".repeat(64);
const SECRET = "synthetic-test-secret-with-at-least-32-characters";

test("concurrent submissions cannot exceed three in a rolling 60-second window", async () => {
  const db = new SqliteD1();
  try {
    const results = await Promise.all(Array.from({ length: 24 }, () => consumeClientSubmission(db.database, A, NOW)));
    assert.equal(results.filter((result) => result.allowed).length, 3);
    assert.equal(db.count(), 3);
    assert.deepEqual(await consumeClientSubmission(db.database, A, new Date(NOW.getTime() + 59_000)), {
      allowed: false, reason: "client_limit", retryAfterSeconds: 1,
    });
    assert.equal((await consumeClientSubmission(db.database, A, new Date(NOW.getTime() + 60_000))).allowed, true);
  } finally { db.close(); }
});

test("daily allowance survives minute expiry and resets only at UTC day rollover", async () => {
  const db = new SqliteD1();
  try {
    for (let i = 0; i < CLIENT_DAY_LIMIT; i++) {
      const time = new Date(NOW.getTime() + Math.floor(i / 3) * 60_000);
      assert.equal((await consumeClientSubmission(db.database, A, time)).allowed, true);
    }
    const deniedAt = new Date("2026-10-29T12:10:00Z");
    assert.deepEqual(await consumeClientSubmission(db.database, A, deniedAt), {
      allowed: false, reason: "client_limit", retryAfterSeconds: 42_600,
    });
    assert.equal((await consumeClientSubmission(db.database, A, new Date("2026-10-30T00:00:00Z"))).allowed, true);
  } finally { db.close(); }
});

test("UTC rollover does not bypass the rolling minute guard", async () => {
  const db = new SqliteD1();
  try {
    const before = new Date("2026-10-29T23:59:50Z");
    for (let i = 0; i < 3; i++) assert.equal((await consumeClientSubmission(db.database, A, before)).allowed, true);
    assert.deepEqual(await consumeClientSubmission(db.database, A, new Date("2026-10-30T00:00:00Z")), {
      allowed: false, reason: "client_limit", retryAfterSeconds: 50,
    });
  } finally { db.close(); }
});

test("pseudonyms are isolated and old records are removed on the next submission", async () => {
  const db = new SqliteD1();
  try {
    for (let i = 0; i < 3; i++) await consumeClientSubmission(db.database, A, NOW);
    assert.equal((await consumeClientSubmission(db.database, B, NOW)).allowed, true);
    assert.equal(db.count(), 4);
    assert.equal((await consumeClientSubmission(db.database, B, new Date(NOW.getTime() + 86_400_001))).allowed, true);
    assert.equal(db.count(), 1);
  } finally { db.close(); }
});

test("missing storage or malformed pseudonyms fail closed without a write", async () => {
  const db = new SqliteD1();
  try {
    for (const id of [undefined, "", "203.0.113.4", "user-123", "a".repeat(63)]) {
      assert.equal((await consumeClientSubmission(db.database, id, NOW)).allowed, false);
    }
    assert.equal(db.batches, 0);
    assert.equal((await consumeClientSubmission(undefined, A, NOW)).allowed, false);
    assert.equal((await consumeClientSubmission(db.database, A, new Date("invalid"))).allowed, false);
  } finally { db.close(); }
});

test("storage failures deny dispatch; lost replies still consume the accepted slot", async () => {
  const db = new SqliteD1();
  try {
    db.failAtStatement = 2;
    assert.equal((await consumeClientSubmission(db.database, A, NOW)).allowed, false);
    assert.equal(db.count(), 0);
    db.failAtStatement = -1;
    db.loseReplyAfterCommit = true;
    assert.equal((await consumeClientSubmission(db.database, A, NOW)).allowed, false);
    assert.equal(db.count(), 1);
    db.loseReplyAfterCommit = false;
    assert.equal((await consumeClientSubmission(db.database, A, NOW)).allowed, true);
    assert.equal((await consumeClientSubmission(db.database, A, NOW)).allowed, true);
    assert.equal((await consumeClientSubmission(db.database, A, NOW)).allowed, false);
  } finally { db.close(); }
});

test("untrusted cookies and forwarded headers cannot supply a trusted identity", async () => {
  const headers = new Headers({
    "cookie": "clientId=some-new-random-value", "x-forwarded-for": "203.0.113.4",
    "x-real-ip": "203.0.113.4", "x-client-id": "some-new-random-value",
  });
  assert.equal(await clientPseudonym(headers, SECRET, "sites-user"), undefined);
  assert.equal(await clientPseudonym(headers, SECRET, "cloudflare-ip"), undefined);
  assert.equal(await clientPseudonym(headers, SECRET, "unknown"), undefined);
  headers.set("oai-authenticated-user-id", "synthetic-user-id");
  assert.equal(await clientPseudonym(headers, undefined, "sites-user"), undefined);
  assert.equal(await clientPseudonym(headers, "short", "sites-user"), undefined);
});

test("HMAC hides raw identity, normalizes IPs and changes with secret or identity", async () => {
  const headers = new Headers({ "oai-authenticated-user-id": "synthetic-user-id" });
  const first = await clientPseudonym(headers, SECRET, "sites-user");
  assert.match(first!, /^[a-f0-9]{64}$/);
  assert.equal(await clientPseudonym(headers, SECRET, "sites-user"), first);
  assert.notEqual(await clientPseudonym(headers, SECRET + "changed", "sites-user"), first);
  headers.set("oai-authenticated-user-id", "another-user-id");
  assert.notEqual(await clientPseudonym(headers, SECRET, "sites-user"), first);
  const ip = new Headers({ "cf-connecting-ip": "2001:0db8:0000:0000:0000:0000:0000:0001" });
  const normalized = await clientPseudonym(ip, SECRET, "cloudflare-ip");
  ip.set("cf-connecting-ip", "2001:db8::1");
  assert.equal(await clientPseudonym(ip, SECRET, "cloudflare-ip"), normalized);
  for (const invalid of ["a.example", "203.0.113.4, 203.0.113.5", "999.1.1.1", "::broken"]) {
    ip.set("cf-connecting-ip", invalid);
    assert.equal(await clientPseudonym(ip, SECRET, "cloudflare-ip"), undefined);
  }
  const db = new SqliteD1();
  try {
    await consumeClientSubmission(db.database, first, NOW);
    const stored = JSON.stringify(db.sqlite.prepare("SELECT * FROM ai_client_submissions").all());
    assert.ok(!stored.includes("synthetic-user-id"));
    assert.ok(!stored.includes(SECRET));
    assert.ok(stored.includes(first!));
  } finally { db.close(); }
});

test("browser sessions are server-issued, signed, secure and stable within a UTC day", async () => {
  const created = await resolveThrottleClient(new Headers(), SECRET, "browser-session", NOW);
  assert.match(created.clientHash!, /^[a-f0-9]{64}$/);
  for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=43200", "Expires=Fri, 30 Oct 2026 00:00:00 GMT"]) {
    assert.ok(created.setCookie!.includes(attribute));
  }
  assert.ok(created.setCookie!.startsWith(`${SESSION_COOKIE_NAME}=`));
  assert.ok(!created.setCookie!.includes("Domain="));
  const headers = new Headers({ cookie: created.setCookie!.split(";")[0] });
  const reused = await resolveThrottleClient(headers, SECRET, "browser-session", new Date(NOW.getTime() + 30_000));
  assert.equal(reused.clientHash, created.clientHash);
  assert.equal(reused.setCookie, undefined);
  // Other client-supplied headers do not select a different browser identity.
  headers.set("x-forwarded-for", "203.0.113.4");
  headers.set("oai-authenticated-user-id", "some-other-id");
  assert.equal((await resolveThrottleClient(headers, SECRET, "browser-session", NOW)).clientHash, created.clientHash);
});

test("tampered, unsigned, duplicate and expired browser cookies never select their supplied ID", async () => {
  const created = await resolveThrottleClient(new Headers(), SECRET, "browser-session", NOW);
  const pair = created.setCookie!.split(";")[0];
  const value = pair.slice(pair.indexOf("=") + 1);
  const [id, expiry, signature] = value.split(".");
  const otherId = `${id[0] === "a" ? "b" : "a"}${id.slice(1)}`;
  const changedSignature = `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
  for (const cookie of [
    `${SESSION_COOKIE_NAME}=${otherId}.${expiry}.${signature}`,
    `${SESSION_COOKIE_NAME}=${id}.${Number(expiry) + 86400}.${signature}`,
    `${SESSION_COOKIE_NAME}=${id}.${expiry}.${changedSignature}`,
    `${SESSION_COOKIE_NAME}=${id}.${expiry}`,
    `${pair}; ${pair}`,
  ]) {
    const renewed = await resolveThrottleClient(new Headers({ cookie }), SECRET, "browser-session", NOW);
    assert.notEqual(renewed.clientHash, created.clientHash);
    assert.ok(renewed.setCookie);
  }
  const expired = await resolveThrottleClient(new Headers({ cookie: pair }), SECRET, "browser-session", new Date("2026-10-30T00:00:00Z"));
  assert.notEqual(expired.clientHash, created.clientHash);
  assert.ok(expired.setCookie);
  const rotatedSecret = await resolveThrottleClient(new Headers({ cookie: pair }), SECRET + "rotated", "browser-session", NOW);
  assert.ok(rotatedSecret.setCookie);
  assert.deepEqual(await resolveThrottleClient(new Headers(), undefined, "browser-session", NOW), {});
});

test("reusing a signed browser session reaches the persistent guard", async () => {
  const db = new SqliteD1();
  try {
    const first = await resolveThrottleClient(new Headers(), SECRET, "browser-session", NOW);
    const headers = new Headers({ cookie: first.setCookie!.split(";")[0] });
    for (let i = 0; i < 3; i++) {
      const client = await resolveThrottleClient(headers, SECRET, "browser-session", NOW);
      assert.equal((await consumeClientSubmission(db.database, client.clientHash, NOW)).allowed, true);
    }
    const again = await resolveThrottleClient(headers, SECRET, "browser-session", NOW);
    assert.equal((await consumeClientSubmission(db.database, again.clientHash, NOW)).allowed, false);
    assert.equal(db.count(), 3);
  } finally { db.close(); }
});

test("clearing cookies creates another session, so the global budget must remain authoritative", async () => {
  const first = await resolveThrottleClient(new Headers(), SECRET, "browser-session", NOW);
  const cleared = await resolveThrottleClient(new Headers(), SECRET, "browser-session", NOW);
  assert.notEqual(first.clientHash, cleared.clientHash);
  assert.ok(cleared.setCookie);
});
