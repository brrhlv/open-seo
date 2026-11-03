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

// PAI-255: buyer prompts. A short per-project list of prompts asked of each AI
// platform once a month; remove = deactivate so the history stays.
export const AI_VISIBILITY_PROMPT_PLATFORMS = [
  "chat_gpt",
  "google_ai_mode",
  "perplexity",
] as const;

export const aiVisibilityPrompts = sqliteTable(
  "ai_visibility_prompts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    // JSON array of AI_VISIBILITY_PROMPT_PLATFORMS keys.
    platformsJson: text("platforms_json")
      .notNull()
      .default('["chat_gpt","google_ai_mode","perplexity"]'),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    nextRunAt: text("next_run_at"),
    lastRunAt: text("last_run_at"),
    lastError: text("last_error"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("ai_visibility_prompts_project_prompt_idx").on(
      table.projectId,
      table.prompt,
    ),
    index("ai_visibility_prompts_due_idx").on(table.isActive, table.nextRunAt),
  ],
);

// One row per (prompt, platform, UTC month). A re-run in the same month
// replaces the row; cost_usd and attempts accumulate.
export const aiVisibilityPromptResults = sqliteTable(
  "ai_visibility_prompt_results",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    promptId: text("prompt_id")
      .notNull()
      .references(() => aiVisibilityPrompts.id, { onDelete: "cascade" }),
    platform: text("platform", {
      enum: AI_VISIBILITY_PROMPT_PLATFORMS,
    }).notNull(),
    period: text("period").notNull(),
    status: text("status", { enum: ["ok", "error"] }).notNull(),
    mentioned: integer("mentioned", { mode: "boolean" }),
    position: integer("position"),
    brandsNamed: integer("brands_named"),
    citedUrl: text("cited_url"),
    citedUrlsJson: text("cited_urls_json").notNull().default("[]"),
    competitorsJson: text("competitors_json").notNull().default("[]"),
    excerpt: text("excerpt"),
    model: text("model"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(1),
    costUsd: real("cost_usd").notNull().default(0),
    capturedAt: text("captured_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("ai_visibility_prompt_results_prompt_platform_period_idx").on(
      table.promptId,
      table.platform,
      table.period,
    ),
  ],
);
