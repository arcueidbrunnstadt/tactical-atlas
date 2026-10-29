CREATE TABLE `ai_call_reservations` (
	`request_id` text PRIMARY KEY NOT NULL,
	`owner_nonce` text NOT NULL,
	`day_key` text NOT NULL,
	`state` text NOT NULL,
	`reserved_cents` integer DEFAULT 0 NOT NULL,
	`denial_reason` text,
	`config_version` text DEFAULT 'trial-v1' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`day_key`) REFERENCES `ai_daily_usage`(`day_key`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_reservation_valid_state" CHECK("ai_call_reservations"."state" IN ('pending', 'reserved', 'denied')),
	CONSTRAINT "ai_reservation_charge_within_unit" CHECK("ai_call_reservations"."reserved_cents" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE `ai_daily_usage` (
	`day_key` text PRIMARY KEY NOT NULL,
	`call_limit` integer DEFAULT 100 NOT NULL,
	`reserved_calls` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_daily_limit_within_ceiling" CHECK("ai_daily_usage"."call_limit" BETWEEN 0 AND 100),
	CONSTRAINT "ai_daily_reserved_within_limit" CHECK("ai_daily_usage"."reserved_calls" BETWEEN 0 AND "ai_daily_usage"."call_limit")
);
--> statement-breakpoint
CREATE TABLE `ai_trial_budget` (
	`id` text PRIMARY KEY NOT NULL,
	`limit_cents` integer DEFAULT 1000 NOT NULL,
	`reserved_cents` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_trial_limit_within_approval" CHECK("ai_trial_budget"."limit_cents" BETWEEN 0 AND 1000),
	CONSTRAINT "ai_trial_reserved_within_limit" CHECK("ai_trial_budget"."reserved_cents" BETWEEN 0 AND "ai_trial_budget"."limit_cents")
);
