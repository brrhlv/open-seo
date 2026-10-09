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
