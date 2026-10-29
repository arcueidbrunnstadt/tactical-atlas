import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// This ledger covers one cumulative trial. A new UTC day or model configuration
// must not create another lifetime allowance.
export const aiTrialBudget = sqliteTable("ai_trial_budget", {
  id: text("id").primaryKey(),
  limitCents: integer("limit_cents").notNull().default(1000),
  reservedCents: integer("reserved_cents").notNull().default(0),
}, (table) => [
  check("ai_trial_limit_within_approval", sql`${table.limitCents} BETWEEN 0 AND 1000`),
  check("ai_trial_reserved_within_limit", sql`${table.reservedCents} BETWEEN 0 AND ${table.limitCents}`),
]);

export const aiDailyUsage = sqliteTable("ai_daily_usage", {
  dayKey: text("day_key").primaryKey(),
  callLimit: integer("call_limit").notNull().default(100),
  reservedCalls: integer("reserved_calls").notNull().default(0),
}, (table) => [
  check("ai_daily_limit_within_ceiling", sql`${table.callLimit} BETWEEN 0 AND 100`),
  check("ai_daily_reserved_within_limit", sql`${table.reservedCalls} BETWEEN 0 AND ${table.callLimit}`),
]);

export const aiCallReservations = sqliteTable("ai_call_reservations", {
  requestId: text("request_id").primaryKey(),
  ownerNonce: text("owner_nonce").notNull(),
  dayKey: text("day_key").notNull().references(() => aiDailyUsage.dayKey),
  state: text("state", { enum: ["pending", "reserved", "denied"] }).notNull(),
  reservedCents: integer("reserved_cents").notNull().default(0),
  denialReason: text("denial_reason"),
  configVersion: text("config_version").notNull().default("deepseek-v1"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  check("ai_reservation_valid_state", sql`${table.state} IN ('pending', 'reserved', 'denied')`),
  // Retain legacy one-cent reservations while new DeepSeek calls reserve three.
  check("ai_reservation_charge_within_unit", sql`${table.reservedCents} BETWEEN 0 AND 3`),
]);

// Short-lived keyed pseudonyms only. Raw IPs, user IDs and requests never enter
// this table. A request removes records older than 24 hours before counting.
export const aiClientSubmissions = sqliteTable("ai_client_submissions", {
  attemptId: text("attempt_id").primaryKey(),
  clientHash: text("client_hash").notNull(),
  dayKey: text("day_key").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("ai_client_submission_time").on(table.clientHash, table.createdAt),
  index("ai_client_submission_day").on(table.clientHash, table.dayKey),
  index("ai_client_submission_expiry").on(table.createdAt),
]);

// Voluntarily submitted feedback is private to the maintainer. Content has no
// client identifier; a later submission cleans messages older than 90 days.
export const feedbackMessages = sqliteTable("feedback_messages", {
  requestId: text("request_id").primaryKey(),
  category: text("category", { enum: ["idea", "search", "missing-game", "usability"] }).notNull(),
  message: text("message").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  check("feedback_category_valid", sql`${table.category} IN ('idea', 'search', 'missing-game', 'usability')`),
  check("feedback_message_bounded", sql`length(${table.message}) BETWEEN 20 AND 2000`),
  index("feedback_message_expiry").on(table.createdAt),
]);

// Separate, purpose-keyed pseudonyms and 24h counters never touch the AI ledger.
export const feedbackSubmissionGuards = sqliteTable("feedback_submission_guards", {
  requestId: text("request_id").primaryKey(),
  ownerNonce: text("owner_nonce").notNull(),
  clientHash: text("client_hash").notNull(),
  dayKey: text("day_key").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("feedback_guard_client_day").on(table.clientHash, table.dayKey),
  index("feedback_guard_day").on(table.dayKey),
  index("feedback_guard_expiry").on(table.createdAt),
]);
