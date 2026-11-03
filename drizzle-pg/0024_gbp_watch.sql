CREATE TABLE "gbp_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"place_id" text,
	"cid" text,
	"listing_id" text,
	"expected_json" text DEFAULT '{}' NOT NULL,
	"schedule_interval" text DEFAULT 'weekly' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_checked_at" text,
	"next_check_at" text,
	"last_error" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gbp_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"identifier" text,
	"title" text,
	"primary_category" text,
	"additional_categories_json" text DEFAULT '[]' NOT NULL,
	"website" text,
	"phone" text,
	"address" text,
	"description" text,
	"hours_json" text,
	"latitude" real,
	"longitude" real,
	"rating" real,
	"review_count" integer,
	"total_photos" integer,
	"is_claimed" boolean,
	"reviews_json" text,
	"updates_json" text,
	"changes_json" text DEFAULT '[]' NOT NULL,
	"billing_cost_usd" real DEFAULT 0 NOT NULL,
	"captured_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gbp_configs" ADD CONSTRAINT "gbp_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gbp_snapshots" ADD CONSTRAINT "gbp_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gbp_configs_project_idx" ON "gbp_configs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "gbp_configs_due_idx" ON "gbp_configs" USING btree ("is_active","next_check_at");--> statement-breakpoint
CREATE INDEX "gbp_snapshots_project_captured_idx" ON "gbp_snapshots" USING btree ("project_id","captured_at");