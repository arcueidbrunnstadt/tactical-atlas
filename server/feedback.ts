import type { QuotaDatabase } from "./quota.ts";

export const FEEDBACK_CATEGORIES = ["idea", "search", "missing-game", "usability"] as const;
export const FEEDBACK_CLIENT_DAY_LIMIT = 3;
export const FEEDBACK_GLOBAL_DAY_LIMIT = 200;
const DAY_MS = 86_400_000;
const CONTENT_RETENTION_MS = 90 * DAY_MS;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FeedbackInput = { requestId: string; category: typeof FEEDBACK_CATEGORIES[number]; message: string };
export class FeedbackError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) {
    super("Feedback could not be accepted. Check the form and try again.");
    this.name = "FeedbackError"; this.code = code; this.status = status;
  }
}

export function validateFeedbackInput(value: unknown): FeedbackInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FeedbackError("INVALID_FEEDBACK", 400);
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 3 || !["requestId", "category", "message"].every((key) => Object.hasOwn(body, key))
      || typeof body.requestId !== "string" || !UUID_V4.test(body.requestId)
      || typeof body.category !== "string" || !(FEEDBACK_CATEGORIES as readonly string[]).includes(body.category)
      || typeof body.message !== "string") throw new FeedbackError("INVALID_FEEDBACK", 400);
  const message = body.message.trim();
  const characters = Array.from(message).length;
  if (characters < 20 || characters > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)) {
    throw new FeedbackError("INVALID_FEEDBACK", 400);
  }
  return { requestId: body.requestId.toLowerCase(), category: body.category as FeedbackInput["category"], message };
}

/** Only a same-origin JSON form is accepted; no public feedback read API exists. */
export async function readFeedbackRequest(request: Request): Promise<FeedbackInput> {
  const origin = new URL(request.url).origin;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (request.headers.get("origin") !== origin || (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")) {
    throw new FeedbackError("FEEDBACK_ORIGIN_REJECTED", 403);
  }
  if ((request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new FeedbackError("FEEDBACK_JSON_REQUIRED", 415);
  }
  if (!request.body) throw new FeedbackError("INVALID_FEEDBACK", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > 8192) { await reader.cancel(); throw new FeedbackError("FEEDBACK_TOO_LARGE", 413); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new FeedbackError("INVALID_FEEDBACK", 400); }
  return validateFeedbackInput(value);
}

/** Purpose separation prevents storing the AI submission pseudonym in feedback. */
export async function feedbackPseudonym(clientHash: string | undefined, secret: string | undefined): Promise<string | undefined> {
  if (!clientHash || !/^[a-f0-9]{64}$/.test(clientHash) || typeof secret !== "string" || secret.length < 32) return undefined;
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`tactical-atlas-feedback-client-v1:${clientHash}`));
    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch { return undefined; }
}

export type FeedbackResult = { accepted: true; duplicate: boolean }
  | { accepted: false; reason: "client_limit" | "global_limit" | "feedback_unavailable" | "request_conflict" };

/**
 * One D1 transaction covers cleanup, limits and insertion. A lost response can
 * be resubmitted with the same ID without another stored message or limit use.
 * Content has no client hash; guard pseudonyms expire separately after 24h.
 * Cleanup occurs on later submissions, not a scheduled deletion service.
 */
export async function submitFeedback(db: QuotaDatabase | undefined, clientHash: string | undefined,
  input: FeedbackInput, now: Date = new Date()): Promise<FeedbackResult> {
  const unavailable: FeedbackResult = { accepted: false, reason: "feedback_unavailable" };
  if (!db || !clientHash || !/^[a-f0-9]{64}$/.test(clientHash) || !Number.isFinite(now.getTime())) return unavailable;
  try {
    const body = validateFeedbackInput(input);
    const timestamp = now.getTime();
    const day = now.toISOString().slice(0, 10);
    const nonce = crypto.randomUUID();
    type Row = { request_id?: string; owner_nonce?: string; client_hash?: string; category?: string; message?: string; client_count?: number; global_count?: number };
    const reports = await db.batch<Row>([
      db.prepare("DELETE FROM feedback_submission_guards WHERE created_at < ?").bind(timestamp - DAY_MS),
      db.prepare("DELETE FROM feedback_messages WHERE created_at < ?").bind(timestamp - CONTENT_RETENTION_MS),
      db.prepare(`INSERT INTO feedback_submission_guards (request_id, owner_nonce, client_hash, day_key, created_at)
        SELECT ?, ?, ?, ?, ? WHERE
          NOT EXISTS (SELECT 1 FROM feedback_messages WHERE request_id = ?)
          AND NOT EXISTS (SELECT 1 FROM feedback_submission_guards WHERE request_id = ?)
          AND (SELECT COUNT(*) FROM feedback_submission_guards WHERE client_hash = ? AND day_key = ?) < ?
          AND (SELECT COUNT(*) FROM feedback_submission_guards WHERE day_key = ?) < ?`)
        .bind(body.requestId, nonce, clientHash, day, timestamp, body.requestId, body.requestId,
          clientHash, day, FEEDBACK_CLIENT_DAY_LIMIT, day, FEEDBACK_GLOBAL_DAY_LIMIT),
      db.prepare(`INSERT INTO feedback_messages (request_id, category, message, created_at)
        SELECT ?, ?, ?, ? WHERE EXISTS
          (SELECT 1 FROM feedback_submission_guards WHERE request_id = ? AND owner_nonce = ?)`)
        .bind(body.requestId, body.category, body.message, timestamp, body.requestId, nonce),
      db.prepare(`SELECT m.request_id, m.category, m.message, g.client_hash, g.owner_nonce
        FROM feedback_messages m LEFT JOIN feedback_submission_guards g ON g.request_id = m.request_id
        WHERE m.request_id = ?`).bind(body.requestId),
      db.prepare(`SELECT SUM(CASE WHEN client_hash = ? THEN 1 ELSE 0 END) AS client_count,
        COUNT(*) AS global_count FROM feedback_submission_guards WHERE day_key = ?`).bind(clientHash, day),
    ]);
    if (reports.some((report) => !report.success)) return unavailable;
    const stored = reports[4]?.results?.[0];
    if (stored?.request_id === body.requestId) {
      if (stored.client_hash !== clientHash || stored.category !== body.category || stored.message !== body.message) {
        return { accepted: false, reason: "request_conflict" };
      }
      return { accepted: true, duplicate: stored.owner_nonce !== nonce };
    }
    const counts = reports[5]?.results?.[0];
    if (!counts) return unavailable;
    if (Number(counts.global_count) >= FEEDBACK_GLOBAL_DAY_LIMIT) return { accepted: false, reason: "global_limit" };
    if (Number(counts.client_count) >= FEEDBACK_CLIENT_DAY_LIMIT) return { accepted: false, reason: "client_limit" };
    return unavailable;
  } catch { return unavailable; }
}
