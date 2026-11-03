import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  gscConnections,
  projectKeyPages,
  projects,
  urlInspections,
} from "@/db/schema";

// CLIENT-SBLV-194: stored URL Inspection results for project key pages.

export type UrlInspectionRow = typeof urlInspections.$inferSelect;
export type UrlInspectionWrite = Omit<UrlInspectionRow, "id">;

/** Key pages of live projects with a GSC property whose stored inspection is
 *  missing or older than `cutoff` (ISO), oldest first per project. */
async function listDueKeyPages(cutoff: string, limit: number) {
  return db
    .select({
      projectId: projectKeyPages.projectId,
      url: projectKeyPages.url,
      siteUrl: gscConnections.siteUrl,
    })
    .from(projectKeyPages)
    .innerJoin(projects, eq(projects.id, projectKeyPages.projectId))
    .innerJoin(
      gscConnections,
      eq(gscConnections.projectId, projectKeyPages.projectId),
    )
    .leftJoin(
      urlInspections,
      and(
        eq(urlInspections.projectId, projectKeyPages.projectId),
        eq(urlInspections.url, projectKeyPages.url),
      ),
    )
    .where(
      and(
        isNull(projects.archivedAt),
        or(isNull(urlInspections.id), lt(urlInspections.inspectedAt, cutoff)),
      ),
    )
    .orderBy(
      asc(projectKeyPages.projectId),
      sql`${urlInspections.inspectedAt} is not null`,
      asc(urlInspections.inspectedAt),
      asc(projectKeyPages.url),
    )
    .limit(limit);
}

/** Insert or overwrite the latest result for each (project, url). */
async function upsertMany(rows: UrlInspectionWrite[]) {
  for (const row of rows) {
    await db
      .insert(urlInspections)
      .values({ id: crypto.randomUUID(), ...row })
      .onConflictDoUpdate({
        target: [urlInspections.projectId, urlInspections.url],
        set: {
          inspectedUrl: row.inspectedUrl,
          verdict: row.verdict,
          coverageState: row.coverageState,
          indexingState: row.indexingState,
          robotsTxtState: row.robotsTxtState,
          pageFetchState: row.pageFetchState,
          googleCanonical: row.googleCanonical,
          userCanonical: row.userCanonical,
          lastCrawlTime: row.lastCrawlTime,
          crawledAs: row.crawledAs,
          error: row.error,
          inspectedAt: row.inspectedAt,
        },
      });
  }
}

async function listForProject(projectId: string) {
  return db
    .select()
    .from(urlInspections)
    .where(eq(urlInspections.projectId, projectId));
}

export const UrlInspectionRepository = {
  listDueKeyPages,
  upsertMany,
  listForProject,
};
