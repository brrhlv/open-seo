CREATE TABLE "ai_visibility_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"target" text NOT NULL,
	"include_competitors" boolean DEFAULT true NOT NULL,
	"schedule_interval" text DEFAULT 'monthly' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_checked_at" text,
	"next_check_at" text,
	"last_error" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"domain" text NOT NULL,
	"platform" text NOT NULL,
	"period" text NOT NULL,
	"mentions" bigint,
	"ai_search_volume" bigint,
	"cited_pages" integer DEFAULT 0 NOT NULL,
	"top_sources_json" text DEFAULT '[]' NOT NULL,
	"sample_prompts_json" text DEFAULT '[]' NOT NULL,
	"share_of_voice_json" text,
	"billing_cost_usd" real DEFAULT 0 NOT NULL,
	"captured_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_visibility_configs" ADD CONSTRAINT "ai_visibility_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_snapshots" ADD CONSTRAINT "ai_visibility_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_visibility_configs_project_idx" ON "ai_visibility_configs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ai_visibility_configs_due_idx" ON "ai_visibility_configs" USING btree ("is_active","next_check_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_visibility_snapshots_project_platform_period_idx" ON "ai_visibility_snapshots" USING btree ("project_id","platform","period");--> statement-breakpoint
CREATE INDEX "ai_visibility_snapshots_project_captured_idx" ON "ai_visibility_snapshots" USING btree ("project_id","captured_at");