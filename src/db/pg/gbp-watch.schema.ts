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

// CLIENT-SBLV-193: see the SQLite schema for the column notes.
export const gbpConfigs = pgTable(
  "gbp_configs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    placeId: text("place_id"),
    cid: text("cid"),
    listingId: text("listing_id"),
    expectedJson: text("expected_json").notNull().default("{}"),
    includeQuestions: boolean("include_questions").notNull().default(true),
    scheduleInterval: text("schedule_interval", {
      enum: ["weekly", "manual"],
    })
      .notNull()
      .default("weekly"),
    isActive: boolean("is_active").notNull().default(true),
    lastCheckedAt: timestampColumn("last_checked_at"),
    nextCheckAt: timestampColumn("next_check_at"),
    lastError: text("last_error"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("gbp_configs_project_idx").on(table.projectId),
    index("gbp_configs_due_idx").on(table.isActive, table.nextCheckAt),
  ],
);

export const gbpSnapshots = pgTable(
  "gbp_snapshots",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The profile this row is about ("cid:…" / "place_id:…"). A row for a
    // different identifier than the one before starts a new baseline.
    identifier: text("identifier"),
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
    isClaimed: boolean("is_claimed"),
    reviewsJson: text("reviews_json"),
    questionsJson: text("questions_json"),
    updatesJson: text("updates_json"),
    changesJson: text("changes_json").notNull().default("[]"),
    billingCostUsd: real("billing_cost_usd").notNull().default(0),
    capturedAt: timestampColumn("captured_at").notNull().default(isoNow),
  },
  (table) => [
    index("gbp_snapshots_project_captured_idx").on(
      table.projectId,
      table.capturedAt,
    ),
  ],
);
