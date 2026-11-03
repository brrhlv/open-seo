CREATE TABLE `gbp_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`place_id` text,
	`cid` text,
	`listing_id` text,
	`expected_json` text DEFAULT '{}' NOT NULL,
	`schedule_interval` text DEFAULT 'weekly' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`last_checked_at` text,
	`next_check_at` text,
	`last_error` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gbp_configs_project_idx` ON `gbp_configs` (`project_id`);--> statement-breakpoint
CREATE INDEX `gbp_configs_due_idx` ON `gbp_configs` (`is_active`,`next_check_at`);--> statement-breakpoint
CREATE TABLE `gbp_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`identifier` text,
	`title` text,
	`primary_category` text,
	`additional_categories_json` text DEFAULT '[]' NOT NULL,
	`website` text,
	`phone` text,
	`address` text,
	`description` text,
	`hours_json` text,
	`latitude` real,
	`longitude` real,
	`rating` real,
	`review_count` integer,
	`total_photos` integer,
	`is_claimed` integer,
	`reviews_json` text,
	`updates_json` text,
	`changes_json` text DEFAULT '[]' NOT NULL,
	`billing_cost_usd` real DEFAULT 0 NOT NULL,
	`captured_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gbp_snapshots_project_captured_idx` ON `gbp_snapshots` (`project_id`,`captured_at`);