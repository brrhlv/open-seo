import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  gscConnections,
  projectKeyPages,
  projects,
  urlInspections,
} from "@/db/schema";

// CLIENT-SBLV-194: stored URL Inspection results for project key pages.

export type UrlInspectionRow = typeof urlInspections.$inferSelect;

export type InspectionResultFields = Pick<
  UrlInspectionRow,
  | "verdict"
  | "coverageState"
  | "indexingState"
  | "robotsTxtState"
  | "pageFetchState"
  | "googleCanonical"
  | "userCanonical"
  | "lastCrawlTime"
  | "crawledAs"
>;

/** Key pages of live projects with a GSC property that are due: never
 *  inspected first, then the longest overdue, across projects. */
async function listDueKeyPages(now: string, limit: number) {
  return db
    .select({
      projectId: projectKeyPages.projectId,
      url: projectKeyPages.url,
      siteUrl: gscConnections.siteUrl,
      rowId: urlInspections.id,
      nextCheckAt: urlInspections.nextCheckAt,
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
        or(isNull(urlInspections.id), lte(urlInspections.nextCheckAt, now)),
      ),
    )
    .orderBy(
      sql`case when ${urlInspections.id} is null then 0 else 1 end`,
      asc(urlInspections.nextCheckAt),
      asc(projectKeyPages.projectId),
      asc(projectKeyPages.url),
    )
    .limit(limit);
}

export type DueKeyPage = Awaited<ReturnType<typeof listDueKeyPages>>[number];

/**
 * Take a due page for this tick by moving next_check_at to `leaseUntil`, so
 * an overlapping tick skips it. Compare-and-set on the observed
 * next_check_at; a never-inspected page gets its row here (insert, or nothing
 * when another tick inserted it first).
 */
async function claim(
  row: DueKeyPage,
  input: { inspectedUrl: string; now: string; leaseUntil: string },
): Promise<boolean> {
  if (row.rowId && row.nextCheckAt) {
    const updated = await db
      .update(urlInspections)
      .set({ nextCheckAt: input.leaseUntil, attemptedAt: input.now })
      .where(
        and(
          eq(urlInspections.id, row.rowId),
          eq(urlInspections.nextCheckAt, row.nextCheckAt),
        ),
      )
      .returning({ id: urlInspections.id });
    return updated.length > 0;
  }
  const inserted = await db
    .insert(urlInspections)
    .values({
      id: crypto.randomUUID(),
      projectId: row.projectId,
      url: row.url,
      inspectedUrl: input.inspectedUrl,
      attemptedAt: input.now,
      nextCheckAt: input.leaseUntil,
    })
    .onConflictDoNothing()
    .returning({ id: urlInspections.id });
  return inserted.length > 0;
}

const byPage = (projectId: string, url: string) =>
  and(eq(urlInspections.projectId, projectId), eq(urlInspections.url, url));

type Attempt = {
  projectId: string;
  url: string;
  inspectedUrl: string;
  now: string;
  nextCheckAt: string;
};

/** A success replaces the result fields and clears the error. */
async function recordSuccess(
  input: Attempt & { fields: InspectionResultFields },
) {
  await db
    .update(urlInspections)
    .set({
      ...input.fields,
      inspectedUrl: input.inspectedUrl,
      error: null,
      inspectedAt: input.now,
      attemptedAt: input.now,
      nextCheckAt: input.nextCheckAt,
    })
    .where(byPage(input.projectId, input.url));
}

/** A failure records the error and the retry time only; the last good
 *  result (verdict, coverage, inspectedAt) stays. */
async function recordFailure(input: Attempt & { error: string }) {
  await db
    .update(urlInspections)
    .set({
      inspectedUrl: input.inspectedUrl,
      error: input.error,
      attemptedAt: input.now,
      nextCheckAt: input.nextCheckAt,
    })
    .where(byPage(input.projectId, input.url));
}

async function listForProject(projectId: string) {
  return db
    .select()
    .from(urlInspections)
    .where(eq(urlInspections.projectId, projectId));
}

export const UrlInspectionRepository = {
  listDueKeyPages,
  claim,
  recordSuccess,
  recordFailure,
  listForProject,
};
