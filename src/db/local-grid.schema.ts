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

// CLIENT-SBLV-191: the stored Maps rank grid. One tracker per project with its
// keywords; the monthly cron (or an explicit run) stores one snapshot per
// keyword per UTC month and one cell row per grid point. The business is
// matched by place_id / cid only; target_name is a display label.
export const localGridConfigs = sqliteTable(
  "local_grid_configs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    targetName: text("target_name"),
    targetPlaceId: text("target_place_id"),
    targetCid: text("target_cid"),
    centerLatitude: real("center_latitude").notNull(),
    centerLongitude: real("center_longitude").notNull(),
    gridSize: integer("grid_size").notNull().default(3),
    spacingKm: real("spacing_km").notNull().default(2),
    device: text("device", { enum: ["desktop", "mobile"] })
      .notNull()
      .default("mobile"),
    languageCode: text("language_code").notNull().default("en"),
    scheduleInterval: text("schedule_interval", {
      enum: ["monthly", "manual"],
    })
      .notNull()
      .default("monthly"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    lastCheckedAt: text("last_checked_at"),
    nextCheckAt: text("next_check_at"),
    // A run in progress (cron or MCP) holds this until it ends or expires.
    leaseUntil: text("lease_until"),
    lastError: text("last_error"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("local_grid_configs_project_idx").on(table.projectId),
    index("local_grid_configs_due_idx").on(table.isActive, table.nextCheckAt),
  ],
);

export const localGridKeywords = sqliteTable(
  "local_grid_keywords",
  {
    id: text("id").primaryKey(),
    configId: text("config_id")
      .notNull()
      .references(() => localGridConfigs.id, { onDelete: "cascade" }),
    // Stored lowercased; snapshots carry the same text.
    keyword: text("keyword").notNull(),
    // Failed or degraded runs this attempt_period (YYYY-MM); capped per month.
    attempts: integer("attempts").notNull().default(0),
    attemptPeriod: text("attempt_period"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("local_grid_keywords_config_keyword_idx").on(
      table.configId,
      table.keyword,
    ),
  ],
);

// One row per (project, keyword, UTC month). The keyword is text, not a
// foreign key, so history survives removing it from the tracker. The run's
// own geometry is kept so a later config change cannot relabel old rows.
export const localGridSnapshots = sqliteTable(
  "local_grid_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    // UTC calendar month, YYYY-MM.
    period: text("period").notNull(),
    centerLatitude: real("center_latitude").notNull(),
    centerLongitude: real("center_longitude").notNull(),
    gridSize: integer("grid_size").notNull(),
    spacingKm: real("spacing_km").notNull(),
    zoom: integer("zoom").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    pointsSearched: integer("points_searched").notNull(),
    pointsFound: integer("points_found").notNull(),
    // Points whose search failed; over a third and the month is not captured.
    pointsFailed: integer("points_failed").notNull().default(0),
    top3Count: integer("top3_count").notNull(),
    top10Count: integer("top10_count").notNull(),
    solvPct: real("solv_pct"),
    arp: real("arp"),
    atrp: real("atrp"),
    matchedTitle: text("matched_title"),
    matchedPlaceId: text("matched_place_id"),
    matchedCid: text("matched_cid"),
    billingCostUsd: real("billing_cost_usd").notNull().default(0),
    capturedAt: text("captured_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("local_grid_snapshots_project_keyword_period_idx").on(
      table.projectId,
      table.keyword,
      table.period,
    ),
    index("local_grid_snapshots_project_captured_idx").on(
      table.projectId,
      table.capturedAt,
    ),
  ],
);

// One row per grid point of a snapshot; row 0 is the northern edge.
export const localGridCells = sqliteTable(
  "local_grid_cells",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => localGridSnapshots.id, { onDelete: "cascade" }),
    row: integer("row").notNull(),
    col: integer("col").notNull(),
    latitude: real("latitude").notNull(),
    longitude: real("longitude").notNull(),
    // null = not among the top results there.
    rank: integer("rank"),
    // null when the point's search failed.
    resultsCount: integer("results_count"),
    competitorTitle: text("competitor_title"),
    competitorCid: text("competitor_cid"),
    competitorRank: integer("competitor_rank"),
    error: integer("error", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("local_grid_cells_snapshot_cell_idx").on(
      table.snapshotId,
      table.row,
      table.col,
    ),
  ],
);
