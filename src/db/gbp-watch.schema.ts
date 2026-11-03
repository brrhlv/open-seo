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

// CLIENT-SBLV-193: Google Business Profile watch. One watch per project; the
// weekly cron (or an explicit run) stores one gbp_snapshots row per run and
// diffs it against the previous row and against expected_json.
export const gbpConfigs = sqliteTable(
  "gbp_configs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // At least one of cid / place_id (checked in GbpWatchService).
    placeId: text("place_id"),
    cid: text("cid"),
    // GBP manager listing id, for the edit-profile link only.
    listingId: text("listing_id"),
    // The accepted state (gbpExpectedSchema): categories, website, hours.
    expectedJson: text("expected_json").notNull().default("{}"),
    includeQuestions: integer("include_questions", { mode: "boolean" })
      .notNull()
      .default(true),
    scheduleInterval: text("schedule_interval", {
      enum: ["weekly", "manual"],
    })
      .notNull()
      .default("weekly"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    lastCheckedAt: text("last_checked_at"),
    nextCheckAt: text("next_check_at"),
    lastError: text("last_error"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("gbp_configs_project_idx").on(table.projectId),
    index("gbp_configs_due_idx").on(table.isActive, table.nextCheckAt),
  ],
);

// One row per run. Lists are JSON (they are only ever read whole, newest
// snapshot first); a null list means "not collected this run".
export const gbpSnapshots = sqliteTable(
  "gbp_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title"),
    primaryCategory: text("primary_category"),
    additionalCategoriesJson: text("additional_categories_json")
      .notNull()
      .default("[]"),
    website: text("website"),
    phone: text("phone"),
    address: text("address"),
    description: text("description"),
    hoursJson: text("hours_json"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    rating: real("rating"),
    reviewCount: integer("review_count"),
    totalPhotos: integer("total_photos"),
    isClaimed: integer("is_claimed", { mode: "boolean" }),
    reviewsJson: text("reviews_json"),
    questionsJson: text("questions_json"),
    updatesJson: text("updates_json"),
    changesJson: text("changes_json").notNull().default("[]"),
    billingCostUsd: real("billing_cost_usd").notNull().default(0),
    capturedAt: text("captured_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("gbp_snapshots_project_captured_idx").on(
      table.projectId,
      table.capturedAt,
    ),
  ],
);
