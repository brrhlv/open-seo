CREATE TABLE "local_grid_cells" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"row" integer NOT NULL,
	"col" integer NOT NULL,
	"latitude" real NOT NULL,
	"longitude" real NOT NULL,
	"rank" integer,
	"results_count" integer,
	"competitor_title" text,
	"competitor_cid" text,
	"competitor_rank" integer,
	"error" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_grid_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"target_name" text,
	"target_place_id" text,
	"target_cid" text,
	"center_latitude" real NOT NULL,
	"center_longitude" real NOT NULL,
	"grid_size" integer DEFAULT 3 NOT NULL,
	"spacing_km" real DEFAULT 2 NOT NULL,
	"device" text DEFAULT 'mobile' NOT NULL,
	"language_code" text DEFAULT 'en' NOT NULL,
	"schedule_interval" text DEFAULT 'monthly' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_checked_at" text,
	"next_check_at" text,
	"lease_until" text,
	"last_error" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_grid_keywords" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text NOT NULL,
	"keyword" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"attempt_period" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_grid_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"keyword" text NOT NULL,
	"period" text NOT NULL,
	"center_latitude" real NOT NULL,
	"center_longitude" real NOT NULL,
	"grid_size" integer NOT NULL,
	"spacing_km" real NOT NULL,
	"zoom" integer NOT NULL,
	"device" text NOT NULL,
	"points_searched" integer NOT NULL,
	"points_found" integer NOT NULL,
	"points_failed" integer DEFAULT 0 NOT NULL,
	"top3_count" integer NOT NULL,
	"top10_count" integer NOT NULL,
	"solv_pct" real,
	"arp" real,
	"atrp" real,
	"matched_title" text,
	"matched_place_id" text,
	"matched_cid" text,
	"billing_cost_usd" real DEFAULT 0 NOT NULL,
	"captured_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_grid_cells" ADD CONSTRAINT "local_grid_cells_snapshot_id_local_grid_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."local_grid_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_grid_configs" ADD CONSTRAINT "local_grid_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_grid_keywords" ADD CONSTRAINT "local_grid_keywords_config_id_local_grid_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."local_grid_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_grid_snapshots" ADD CONSTRAINT "local_grid_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_grid_cells_snapshot_cell_idx" ON "local_grid_cells" USING btree ("snapshot_id","row","col");--> statement-breakpoint
CREATE UNIQUE INDEX "local_grid_configs_project_idx" ON "local_grid_configs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "local_grid_configs_due_idx" ON "local_grid_configs" USING btree ("is_active","next_check_at");--> statement-breakpoint
CREATE UNIQUE INDEX "local_grid_keywords_config_keyword_idx" ON "local_grid_keywords" USING btree ("config_id","keyword");--> statement-breakpoint
CREATE UNIQUE INDEX "local_grid_snapshots_project_keyword_period_idx" ON "local_grid_snapshots" USING btree ("project_id","keyword","period");--> statement-breakpoint
CREATE INDEX "local_grid_snapshots_project_captured_idx" ON "local_grid_snapshots" USING btree ("project_id","captured_at");