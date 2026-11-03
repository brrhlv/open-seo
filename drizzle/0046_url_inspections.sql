CREATE TABLE `url_inspections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`url` text NOT NULL,
	`inspected_url` text NOT NULL,
	`verdict` text,
	`coverage_state` text,
	`indexing_state` text,
	`robots_txt_state` text,
	`page_fetch_state` text,
	`google_canonical` text,
	`user_canonical` text,
	`last_crawl_time` text,
	`crawled_as` text,
	`error` text,
	`inspected_at` text,
	`attempted_at` text NOT NULL,
	`next_check_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `url_inspections_project_url_idx` ON `url_inspections` (`project_id`,`url`);--> statement-breakpoint
CREATE INDEX `url_inspections_next_check_idx` ON `url_inspections` (`next_check_at`);