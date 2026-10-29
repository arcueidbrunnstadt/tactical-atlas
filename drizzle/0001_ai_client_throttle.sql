CREATE TABLE `ai_client_submissions` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`client_hash` text NOT NULL,
	`day_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_client_submission_time` ON `ai_client_submissions` (`client_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_client_submission_day` ON `ai_client_submissions` (`client_hash`,`day_key`);--> statement-breakpoint
CREATE INDEX `ai_client_submission_expiry` ON `ai_client_submissions` (`created_at`);