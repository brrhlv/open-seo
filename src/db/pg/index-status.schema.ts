import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// CLIENT-SBLV-194: see the SQLite schema for the column notes. Timestamps are
// text, as in pg/app.schema.ts.
export const urlInspections = pgTable(
  "url_inspections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    inspectedUrl: text("inspected_url").notNull(),
    verdict: text("verdict"),
    coverageState: text("coverage_state"),
    indexingState: text("indexing_state"),
    robotsTxtState: text("robots_txt_state"),
    pageFetchState: text("page_fetch_state"),
    googleCanonical: text("google_canonical"),
    userCanonical: text("user_canonical"),
    lastCrawlTime: text("last_crawl_time"),
    crawledAs: text("crawled_as"),
    error: text("error"),
    inspectedAt: text("inspected_at"),
    attemptedAt: text("attempted_at").notNull(),
    nextCheckAt: text("next_check_at").notNull(),
  },
  (table) => [
    uniqueIndex("url_inspections_project_url_idx").on(
      table.projectId,
      table.url,
    ),
    index("url_inspections_next_check_idx").on(table.nextCheckAt),
  ],
);
