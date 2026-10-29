CREATE TABLE `feedback_messages` (
	`request_id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "feedback_category_valid" CHECK("feedback_messages"."category" IN ('idea', 'search', 'missing-game', 'usability')),
	CONSTRAINT "feedback_message_bounded" CHECK(length("feedback_messages"."message") BETWEEN 20 AND 2000)
);
--> statement-breakpoint
CREATE INDEX `feedback_message_expiry` ON `feedback_messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `feedback_submission_guards` (
	`request_id` text PRIMARY KEY NOT NULL,
	`owner_nonce` text NOT NULL,
	`client_hash` text NOT NULL,
	`day_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feedback_guard_client_day` ON `feedback_submission_guards` (`client_hash`,`day_key`);--> statement-breakpoint
CREATE INDEX `feedback_guard_day` ON `feedback_submission_guards` (`day_key`);--> statement-breakpoint
CREATE INDEX `feedback_guard_expiry` ON `feedback_submission_guards` (`created_at`);