CREATE TABLE "ai_visibility_prompt_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"prompt_id" text NOT NULL,
	"platform" text NOT NULL,
	"period" text NOT NULL,
	"status" text NOT NULL,
	"mentioned" boolean,
	"position" integer,
	"brands_named" integer,
	"cited_url" text,
	"cited_urls_json" text DEFAULT '[]' NOT NULL,
	"competitors_json" text DEFAULT '[]' NOT NULL,
	"excerpt" text,
	"model" text,
	"error" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"captured_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"prompt" text NOT NULL,
	"platforms_json" text DEFAULT '["chat_gpt","google_ai_mode","perplexity"]' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"next_run_at" text,
	"last_run_at" text,
	"last_error" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_visibility_prompt_results" ADD CONSTRAINT "ai_visibility_prompt_results_prompt_id_ai_visibility_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."ai_visibility_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_prompts" ADD CONSTRAINT "ai_visibility_prompts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_visibility_prompt_results_prompt_platform_period_idx" ON "ai_visibility_prompt_results" USING btree ("prompt_id","platform","period");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_visibility_prompts_project_prompt_idx" ON "ai_visibility_prompts" USING btree ("project_id","prompt");--> statement-breakpoint
CREATE INDEX "ai_visibility_prompts_due_idx" ON "ai_visibility_prompts" USING btree ("is_active","next_run_at");