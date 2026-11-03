import { sql } from "drizzle-orm";
import {
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

// CLIENT-SBLV-191: see the SQLite schema for the column notes.
export const localGridConfigs = pgTable(
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
    isActive: boolean("is_active").notNull().default(true),
    lastCheckedAt: timestampColumn("last_checked_at"),
    nextCheckAt: timestampColumn("next_check_at"),
    lastError: text("last_error"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("local_grid_configs_project_idx").on(table.projectId),
    index("local_grid_configs_due_idx").on(table.isActive, table.nextCheckAt),
  ],
);

export const localGridKeywords = pgTable(
  "local_grid_keywords",
  {
    id: text("id").primaryKey(),
    configId: text("config_id")
      .notNull()
      .references(() => localGridConfigs.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("local_grid_keywords_config_keyword_idx").on(
      table.configId,
      table.keyword,
    ),
  ],
);

export const localGridSnapshots = pgTable(
  "local_grid_snapshots",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    period: text("period").notNull(),
    centerLatitude: real("center_latitude").notNull(),
    centerLongitude: real("center_longitude").notNull(),
    gridSize: integer("grid_size").notNull(),
    spacingKm: real("spacing_km").notNull(),
    zoom: integer("zoom").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    pointsSearched: integer("points_searched").notNull(),
    pointsFound: integer("points_found").notNull(),
    top3Count: integer("top3_count").notNull(),
    top10Count: integer("top10_count").notNull(),
    solvPct: real("solv_pct"),
    arp: real("arp"),
    atrp: real("atrp"),
    matchedTitle: text("matched_title"),
    matchedPlaceId: text("matched_place_id"),
    matchedCid: text("matched_cid"),
    billingCostUsd: real("billing_cost_usd").notNull().default(0),
    capturedAt: timestampColumn("captured_at").notNull().default(isoNow),
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

export const localGridCells = pgTable(
  "local_grid_cells",
  {
    id: serial("id").primaryKey(),
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => localGridSnapshots.id, { onDelete: "cascade" }),
    row: integer("row").notNull(),
    col: integer("col").notNull(),
    latitude: real("latitude").notNull(),
    longitude: real("longitude").notNull(),
    rank: integer("rank"),
    resultsCount: integer("results_count"),
    competitorTitle: text("competitor_title"),
    competitorCid: text("competitor_cid"),
    competitorRank: integer("competitor_rank"),
    error: boolean("error").notNull().default(false),
  },
  (table) => [
    uniqueIndex("local_grid_cells_snapshot_cell_idx").on(
      table.snapshotId,
      table.row,
      table.col,
    ),
  ],
);
