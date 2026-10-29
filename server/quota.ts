/**
 * A cumulative, non-refundable allowance for this app's first API trial.
 *
 * Reserve before dispatch. The provider adapter must separately establish that
 * one bounded request costs no more than the three-cent reservation and disable
 * SDK/transport retries. This module never calls a provider or reads a secret.
 */
export const TRIAL_LIMIT_CENTS = 1000;
export const RESERVATION_CENTS = 3;
export const UTC_DAY_CALL_LIMIT = 100;

const TRIAL_ID = "public-preview-trial";
const CONFIG_VERSION = "deepseek-v1";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type QuotaDatabase = Pick<D1Database, "prepare" | "batch">;

export type QuotaDenial =
  | "invalid_request_id"
  | "duplicate_request"
  | "trial_exhausted"
  | "daily_limit"
  | "quota_unavailable";

export type QuotaReservation =
  | { allowed: true; requestId: string; reservedCents: number }
  | { allowed: false; reason: QuotaDenial };

type ReservationRow = {
  owner_nonce: string;
  state: "pending" | "reserved" | "denied";
  reserved_cents: number;
  denial_reason: string | null;
};

/**
 * All statements execute as one D1 batch transaction. Each attempt has its own
 * server nonce, so observing an existing reserved ID never authorizes a second
 * upstream call. No raw query, response, client identity or IP enters this API.
 *
 * `now` exists for deterministic boundary tests. Production callers omit it.
 * A denied or uncertain reservation is deliberately never refunded.
 */
export async function reserveAiCall(
  db: QuotaDatabase | undefined,
  requestId: string,
  now: Date = new Date(),
): Promise<QuotaReservation> {
  if (typeof requestId !== "string" || !UUID_V4.test(requestId)) {
    return { allowed: false, reason: "invalid_request_id" };
  }
  if (!db || !Number.isFinite(now.getTime())) {
    return { allowed: false, reason: "quota_unavailable" };
  }

  const id = requestId.toLowerCase();
  const ownerNonce = crypto.randomUUID();
  const dayKey = now.toISOString().slice(0, 10);
  const createdAt = now.getTime();

  try {
    const statements = [
      db.prepare(`INSERT OR IGNORE INTO ai_trial_budget
        (id, limit_cents, reserved_cents) VALUES (?, ?, 0)`)
        .bind(TRIAL_ID, TRIAL_LIMIT_CENTS),
      db.prepare(`INSERT OR IGNORE INTO ai_daily_usage
        (day_key, call_limit, reserved_calls) VALUES (?, ?, 0)`)
        .bind(dayKey, UTC_DAY_CALL_LIMIT),
      db.prepare(`INSERT OR IGNORE INTO ai_call_reservations
        (request_id, owner_nonce, day_key, state, reserved_cents,
         denial_reason, config_version, created_at)
        VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?)`)
        .bind(id, ownerNonce, dayKey, CONFIG_VERSION, createdAt),

      // The transaction marks an owned row before incrementing both counters.
      // D1 batches are non-interleaving transactions: another request cannot
      // observe capacity between this check and the two following increments.
      db.prepare(`UPDATE ai_call_reservations
        SET state = 'reserved', reserved_cents = ?
        WHERE request_id = ? AND owner_nonce = ? AND state = 'pending'
          AND EXISTS (SELECT 1 FROM ai_trial_budget
            WHERE id = ? AND reserved_cents + ? <= MIN(limit_cents, ?))
          AND EXISTS (SELECT 1 FROM ai_daily_usage
            WHERE day_key = ? AND reserved_calls < MIN(call_limit, ?))`)
        .bind(RESERVATION_CENTS, id, ownerNonce, TRIAL_ID,
          RESERVATION_CENTS, TRIAL_LIMIT_CENTS, dayKey, UTC_DAY_CALL_LIMIT),
      db.prepare(`UPDATE ai_trial_budget
        SET reserved_cents = reserved_cents + ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM ai_call_reservations
          WHERE request_id = ? AND owner_nonce = ? AND state = 'reserved')`)
        .bind(RESERVATION_CENTS, TRIAL_ID, id, ownerNonce),
      db.prepare(`UPDATE ai_daily_usage
        SET reserved_calls = reserved_calls + 1
        WHERE day_key = ? AND EXISTS (SELECT 1 FROM ai_call_reservations
          WHERE request_id = ? AND owner_nonce = ? AND state = 'reserved')`)
        .bind(dayKey, id, ownerNonce),
      db.prepare(`UPDATE ai_call_reservations
        SET state = 'denied', denial_reason = CASE
          WHEN EXISTS (SELECT 1 FROM ai_trial_budget
            WHERE id = ? AND reserved_cents + ? > MIN(limit_cents, ?))
            THEN 'trial_exhausted'
          WHEN EXISTS (SELECT 1 FROM ai_daily_usage
            WHERE day_key = ? AND reserved_calls >= MIN(call_limit, ?))
            THEN 'daily_limit'
          ELSE 'quota_unavailable' END
        WHERE request_id = ? AND owner_nonce = ? AND state = 'pending'`)
        .bind(TRIAL_ID, RESERVATION_CENTS, TRIAL_LIMIT_CENTS,
          dayKey, UTC_DAY_CALL_LIMIT, id, ownerNonce),
      db.prepare(`SELECT owner_nonce, state, reserved_cents, denial_reason
        FROM ai_call_reservations WHERE request_id = ?`)
        .bind(id),
    ];

    const results = await db.batch<ReservationRow>(statements);
    if (results.some((result) => !result.success)) {
      return { allowed: false, reason: "quota_unavailable" };
    }
    const row = results[results.length - 1]?.results?.[0];
    if (!row) return { allowed: false, reason: "quota_unavailable" };
    if (row.owner_nonce !== ownerNonce) {
      return { allowed: false, reason: "duplicate_request" };
    }
    if (row.state === "reserved" && row.reserved_cents === RESERVATION_CENTS) {
      return { allowed: true, requestId: id, reservedCents: RESERVATION_CENTS };
    }
    if (row.denial_reason === "trial_exhausted" || row.denial_reason === "daily_limit") {
      return { allowed: false, reason: row.denial_reason };
    }
    return { allowed: false, reason: "quota_unavailable" };
  } catch {
    // A response can be lost after commit. Fail closed; never refund or retry
    // automatically, even when the caller cannot tell whether it was reserved.
    return { allowed: false, reason: "quota_unavailable" };
  }
}
