import type { QuotaDatabase } from "./quota.ts";

export const CLIENT_MINUTE_LIMIT = 3;
export const CLIENT_DAY_LIMIT = 20;
const MINUTE_MS = 60_000;
const RETENTION_MS = 24 * 60 * MINUTE_MS;

export type ClientIdentityMode = "browser-session" | "sites-user" | "cloudflare-ip";
export const SESSION_COOKIE_NAME = "__Host-tactical-atlas-session";
export type ThrottleResult =
  | { allowed: true }
  | { allowed: false; reason: "client_limit" | "throttle_unavailable"; retryAfterSeconds: number };

function canonicalIp(value: string): string | undefined {
  if (value.length > 45 || !/^[0-9a-f:.]+$/i.test(value)) return undefined;
  if (!value.includes(":")) {
    const parts = value.split(".");
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined;
    return parts.map(Number).join(".");
  }
  try { return new URL(`https://[${value}]/`).hostname.toLowerCase(); }
  catch { return undefined; }
}

async function hmac(secret: string, value: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, encoder.encode(value));
}
const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * A signed, server-issued browser session is a best-effort burst guard. Clearing
 * cookies or using another browser starts a new session; only the shared global
 * budget/day limits bound total app expenditure against distributed abuse.
 */
export async function resolveThrottleClient(
  headers: Headers,
  secret: string | undefined,
  mode: string | undefined,
  now: Date = new Date(),
): Promise<{ clientHash?: string; setCookie?: string }> {
  if (mode !== "browser-session") return { clientHash: await clientPseudonym(headers, secret, mode) };
  if (typeof secret !== "string" || secret.length < 32 || !Number.isFinite(now.getTime())) return {};
  try {
    const expiry = Math.floor((Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) + RETENTION_MS) / 1000);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const cookieHeader = headers.get("cookie") ?? "";
    // Reject oversized/duplicate cookies instead of accepting an ambiguous ID.
    const cookies = cookieHeader.length <= 8192
      ? cookieHeader.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`)) : [];
    const raw = cookies.length === 1 ? cookies[0].slice(SESSION_COOKIE_NAME.length + 1) : "";
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(\d{10})\.([0-9a-f]{64})$/.exec(raw);
    let id: string | undefined;
    if (match && Number(match[2]) > nowSeconds && Number(match[2]) === expiry) {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      const bytes = Uint8Array.from(match[3].match(/../g)!, (pair) => Number.parseInt(pair, 16));
      if (await crypto.subtle.verify("HMAC", key, bytes, encoder.encode(`tactical-atlas-session-v1:${match[1]}.${match[2]}`))) id = match[1];
    }
    let setCookie: string | undefined;
    if (!id) {
      id = crypto.randomUUID();
      const unsigned = `${id}.${expiry}`;
      const value = `${unsigned}.${hex(await hmac(secret, `tactical-atlas-session-v1:${unsigned}`))}`;
      setCookie = `${SESSION_COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${expiry - nowSeconds}; Expires=${new Date(expiry * 1000).toUTCString()}`;
    }
    return { clientHash: hex(await hmac(secret, `tactical-atlas-throttle-v1:browser-session:${id}`)), setCookie };
  } catch { return {}; }
}

/**
 * Accept only a deployment-selected trusted identity source. Sites injects its
 * signed-in ID. CF-Connecting-IP must be verified at the deployed ingress before
 * opting into cloudflare-ip: Worker subrequests can change its semantics.
 * Never fall back to X-Forwarded-For, arbitrary cookies or a browser-supplied ID.
 */
export async function clientPseudonym(
  headers: Headers,
  secret: string | undefined,
  mode: string | undefined,
): Promise<string | undefined> {
  if (typeof secret !== "string" || secret.length < 32) return undefined;
  let identity: string | undefined;
  if (mode === "sites-user") {
    const id = headers.get("oai-authenticated-user-id");
    if (id && /^[A-Za-z0-9_-]{1,128}$/.test(id)) identity = `sites-user:${id}`;
  } else if (mode === "cloudflare-ip") {
    const ip = canonicalIp(headers.get("cf-connecting-ip") ?? "");
    if (ip) identity = `cloudflare-ip:${ip}`;
  }
  if (!identity) return undefined;
  try {
    return hex(await hmac(secret, `tactical-atlas-throttle-v1:${identity}`));
  } catch { return undefined; }
}

/**
 * One D1 batch is one non-interleaving transaction. The conditional INSERT and
 * ownership SELECT authorize at most 3 accepted submissions in the rolling last
 * 60 seconds and 20 per UTC day for this pseudonym, across all Worker isolates.
 * Failed/duplicate provider submissions still consume this small allowance.
 * This guard never reserves money; the global budget guard remains required.
 */
export async function consumeClientSubmission(
  db: QuotaDatabase | undefined,
  clientHash: string | undefined,
  now: Date = new Date(),
): Promise<ThrottleResult> {
  const unavailable: ThrottleResult = { allowed: false, reason: "throttle_unavailable", retryAfterSeconds: 60 };
  if (!db || typeof clientHash !== "string" || !/^[a-f0-9]{64}$/.test(clientHash) || !Number.isFinite(now.getTime())) return unavailable;
  const timestamp = now.getTime();
  const day = now.toISOString().slice(0, 10);
  const attempt = crypto.randomUUID();
  try {
    const results = await db.batch<{ attempt_id?: string; day_count?: number; oldest_recent?: number | null }>([
      db.prepare("DELETE FROM ai_client_submissions WHERE created_at < ?").bind(timestamp - RETENTION_MS),
      db.prepare(`INSERT INTO ai_client_submissions (attempt_id, client_hash, day_key, created_at)
        SELECT ?, ?, ?, ? WHERE
          (SELECT COUNT(*) FROM ai_client_submissions WHERE client_hash = ? AND created_at > ?) < ?
          AND (SELECT COUNT(*) FROM ai_client_submissions WHERE client_hash = ? AND day_key = ?) < ?`)
        .bind(attempt, clientHash, day, timestamp, clientHash, timestamp - MINUTE_MS, CLIENT_MINUTE_LIMIT, clientHash, day, CLIENT_DAY_LIMIT),
      db.prepare("SELECT attempt_id FROM ai_client_submissions WHERE attempt_id = ?").bind(attempt),
      db.prepare(`SELECT SUM(CASE WHEN day_key = ? THEN 1 ELSE 0 END) AS day_count,
        MIN(CASE WHEN created_at > ? THEN created_at ELSE NULL END) AS oldest_recent
        FROM ai_client_submissions WHERE client_hash = ?`)
        .bind(day, timestamp - MINUTE_MS, clientHash),
    ]);
    if (results.some((result) => !result.success)) return unavailable;
    if (results[2]?.results?.[0]?.attempt_id === attempt) return { allowed: true };
    const counts = results[3]?.results?.[0];
    if (!counts) return unavailable;
    const resetAt = Number(counts.day_count) >= CLIENT_DAY_LIMIT
      ? Date.parse(`${day}T00:00:00Z`) + RETENTION_MS
      : Number(counts.oldest_recent) + MINUTE_MS;
    return { allowed: false, reason: "client_limit",
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - timestamp) / 1000)) };
  } catch { return unavailable; }
}
