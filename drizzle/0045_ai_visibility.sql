CREATE TABLE `ai_visibility_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`target` text NOT NULL,
	`include_competitors` integer DEFAULT true NOT NULL,
	`schedule_interval` text DEFAULT 'monthly' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`last_checked_at` text,
	`next_check_at` text,
	`last_error` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_visibility_configs_project_idx` ON `ai_visibility_configs` (`project_id`);--> statement-breakpoint
CREATE INDEX `ai_visibility_configs_due_idx` ON `ai_visibility_configs` (`is_active`,`next_check_at`);--> statement-breakpoint
CREATE TABLE `ai_visibility_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`domain` text NOT NULL,
	`platform` text NOT NULL,
	`period` text NOT NULL,
	`mentions` integer,
	`ai_search_volume` integer,
	`cited_pages` integer DEFAULT 0 NOT NULL,
	`top_sources_json` text DEFAULT '[]' NOT NULL,
	`sample_prompts_json` text DEFAULT '[]' NOT NULL,
	`share_of_voice_json` text,
	`billing_cost_usd` real DEFAULT 0 NOT NULL,
	`captured_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_visibility_snapshots_project_platform_period_idx` ON `ai_visibility_snapshots` (`project_id`,`platform`,`period`);--> statement-breakpoint
CREATE INDEX `ai_visibility_snapshots_project_captured_idx` ON `ai_visibility_snapshots` (`project_id`,`captured_at`);