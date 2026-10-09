import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./app.schema";

// PAI-217: persistent AI-visibility tracking. One tracker per project; the
// monthly cron (or an explicit run) snapshots Brand Lookup into
// ai_visibility_snapshots. Competitors are not copied here — a run reads the
// project's current project_competitors rows when includeCompetitors is set.
export const aiVisibilityConfigs = sqliteTable(
  "ai_visibility_configs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Brand name or domain passed to Brand Lookup.
    target: text("target").notNull(),
    includeCompetitors: integer("include_competitors", { mode: "boolean" })
      .notNull()
      .default(true),
    scheduleInterval: text("schedule_interval", {
      enum: ["monthly", "manual"],
    })
      .notNull()
      .default("monthly"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    lastCheckedAt: text("last_checked_at"),
    nextCheckAt: text("next_check_at"),
    lastError: text("last_error"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("ai_visibility_configs_project_idx").on(table.projectId),
    index("ai_visibility_configs_due_idx").on(
      table.isActive,
      table.nextCheckAt,
    ),
  ],
);

// One row per (project, platform, calendar month). A re-run inside the same
// month upserts onto the row and adds its DataForSEO cost to billing_cost_usd.
export const aiVisibilitySnapshots = sqliteTable(
  "ai_visibility_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    platform: text("platform", { enum: ["chat_gpt", "google"] }).notNull(),
    // UTC calendar month, YYYY-MM.
    period: text("period").notNull(),
    mentions: integer("mentions"),
    aiSearchVolume: integer("ai_search_volume"),
    citedPages: integer("cited_pages").notNull().default(0),
    topSourcesJson: text("top_sources_json").notNull().default("[]"),
    samplePromptsJson: text("sample_prompts_json").notNull().default("[]"),
    shareOfVoiceJson: text("share_of_voice_json"),
    billingCostUsd: real("billing_cost_usd").notNull().default(0),
    capturedAt: text("captured_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("ai_visibility_snapshots_project_platform_period_idx").on(
      table.projectId,
      table.platform,
      table.period,
    ),
    index("ai_visibility_snapshots_project_captured_idx").on(
      table.projectId,
      table.capturedAt,
    ),
  ],
);
