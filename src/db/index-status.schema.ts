import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";

// CLIENT-SBLV-194: latest Search Console URL Inspection per project key page.
// The */5 cron refreshes a URL at most once a day (inspection is
// quota-limited); the public summary only ever reads these rows. One row per
// (project, url), overwritten in place — no history. The cron leases a
// row (next_check_at a few minutes out) before inspecting it.
export const urlInspections = sqliteTable(
  "url_inspections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The key page URL as stored in project_key_pages.
    url: text("url").notNull(),
    // The URL sent to GSC (rebased onto a URL-prefix property's origin).
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
    // The last attempt's failure; null after a success. A failure never
    // clears the result fields above, so the last good verdict stays.
    error: text("error"),
    // ISO: when the result fields were captured (null until one succeeds).
    inspectedAt: text("inspected_at"),
    // ISO: the last attempt, success or not (or the start of a lease).
    attemptedAt: text("attempted_at").notNull(),
    // ISO: when the cron may inspect again (a day after a success, an hour
    // after a transient failure, a few minutes while a tick holds the lease).
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
