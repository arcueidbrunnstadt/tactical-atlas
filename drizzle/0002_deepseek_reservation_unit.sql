-- Rebuild only this leaf table with foreign-key enforcement left enabled.
-- Preserve every historical reservation; the parent budget/day tables are untouched.
CREATE TABLE `__new_ai_call_reservations` (
	`request_id` text PRIMARY KEY NOT NULL,
	`owner_nonce` text NOT NULL,
	`day_key` text NOT NULL,
	`state` text NOT NULL,
	`reserved_cents` integer DEFAULT 0 NOT NULL,
	`denial_reason` text,
	`config_version` text DEFAULT 'deepseek-v1' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`day_key`) REFERENCES `ai_daily_usage`(`day_key`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_reservation_valid_state" CHECK("__new_ai_call_reservations"."state" IN ('pending', 'reserved', 'denied')),
	CONSTRAINT "ai_reservation_charge_within_unit" CHECK("__new_ai_call_reservations"."reserved_cents" BETWEEN 0 AND 3)
);
--> statement-breakpoint
INSERT INTO `__new_ai_call_reservations`("request_id", "owner_nonce", "day_key", "state", "reserved_cents", "denial_reason", "config_version", "created_at") SELECT "request_id", "owner_nonce", "day_key", "state", "reserved_cents", "denial_reason", "config_version", "created_at" FROM `ai_call_reservations`;--> statement-breakpoint
DROP TABLE `ai_call_reservations`;--> statement-breakpoint
ALTER TABLE `__new_ai_call_reservations` RENAME TO `ai_call_reservations`;
