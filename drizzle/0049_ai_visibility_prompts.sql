CREATE TABLE `ai_visibility_prompt_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`prompt_id` text NOT NULL,
	`platform` text NOT NULL,
	`period` text NOT NULL,
	`status` text NOT NULL,
	`mentioned` integer,
	`position` integer,
	`brands_named` integer,
	`cited_url` text,
	`cited_urls_json` text DEFAULT '[]' NOT NULL,
	`competitors_json` text DEFAULT '[]' NOT NULL,
	`excerpt` text,
	`model` text,
	`error` text,
	`attempts` integer DEFAULT 1 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`captured_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`prompt_id`) REFERENCES `ai_visibility_prompts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_visibility_prompt_results_prompt_platform_period_idx` ON `ai_visibility_prompt_results` (`prompt_id`,`platform`,`period`);--> statement-breakpoint
CREATE TABLE `ai_visibility_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`prompt` text NOT NULL,
	`platforms_json` text DEFAULT '["chat_gpt","google_ai_mode","perplexity"]' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`next_run_at` text,
	`last_run_at` text,
	`last_error` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_visibility_prompts_project_prompt_idx` ON `ai_visibility_prompts` (`project_id`,`prompt`);--> statement-breakpoint
CREATE INDEX `ai_visibility_prompts_due_idx` ON `ai_visibility_prompts` (`is_active`,`next_run_at`);