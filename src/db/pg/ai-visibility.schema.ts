import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  real,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// Timestamps are stored as *text* (same column shape as the SQLite schema); see
// the note in pg/app.schema.ts.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);

// PAI-217: see the SQLite schema for the column notes.
export const aiVisibilityConfigs = pgTable(
  "ai_visibility_configs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
    includeCompetitors: boolean("include_competitors").notNull().default(true),
    scheduleInterval: text("schedule_interval", {
      enum: ["monthly", "manual"],
    })
      .notNull()
      .default("monthly"),
    isActive: boolean("is_active").notNull().default(true),
    lastCheckedAt: timestampColumn("last_checked_at"),
    nextCheckAt: timestampColumn("next_check_at"),
    lastError: text("last_error"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("ai_visibility_configs_project_idx").on(table.projectId),
    index("ai_visibility_configs_due_idx").on(
      table.isActive,
      table.nextCheckAt,
    ),
  ],
);

export const aiVisibilitySnapshots = pgTable(
  "ai_visibility_snapshots",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    platform: text("platform", { enum: ["chat_gpt", "google"] }).notNull(),
    period: text("period").notNull(),
    mentions: bigint("mentions", { mode: "number" }),
    aiSearchVolume: bigint("ai_search_volume", { mode: "number" }),
    citedPages: integer("cited_pages").notNull().default(0),
    topSourcesJson: text("top_sources_json").notNull().default("[]"),
    samplePromptsJson: text("sample_prompts_json").notNull().default("[]"),
    shareOfVoiceJson: text("share_of_voice_json"),
    billingCostUsd: real("billing_cost_usd").notNull().default(0),
    capturedAt: timestampColumn("captured_at").notNull().default(isoNow),
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

// PAI-255: see the SQLite schema for the column notes.
const AI_VISIBILITY_PROMPT_PLATFORMS = [
  "chat_gpt",
  "google_ai_mode",
  "perplexity",
] as const;

export const aiVisibilityPrompts = pgTable(
  "ai_visibility_prompts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    platformsJson: text("platforms_json")
      .notNull()
      .default('["chat_gpt","google_ai_mode","perplexity"]'),
    isActive: boolean("is_active").notNull().default(true),
    nextRunAt: timestampColumn("next_run_at"),
    lastRunAt: timestampColumn("last_run_at"),
    lastError: text("last_error"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("ai_visibility_prompts_project_prompt_idx").on(
      table.projectId,
      table.prompt,
    ),
    index("ai_visibility_prompts_due_idx").on(table.isActive, table.nextRunAt),
  ],
);

export const aiVisibilityPromptResults = pgTable(
  "ai_visibility_prompt_results",
  {
    id: serial("id").primaryKey(),
    promptId: text("prompt_id")
      .notNull()
      .references(() => aiVisibilityPrompts.id, { onDelete: "cascade" }),
    platform: text("platform", {
      enum: AI_VISIBILITY_PROMPT_PLATFORMS,
    }).notNull(),
    period: text("period").notNull(),
    status: text("status", { enum: ["ok", "error"] }).notNull(),
    mentioned: boolean("mentioned"),
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
    capturedAt: timestampColumn("captured_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("ai_visibility_prompt_results_prompt_platform_period_idx").on(
      table.promptId,
      table.platform,
      table.period,
    ),
  ],
);
