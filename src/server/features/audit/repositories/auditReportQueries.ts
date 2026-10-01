import { and, desc, eq, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { auditLighthouseResults, auditPages, audits } from "@/db/schema";

// Report API (BRRHLV-375) as-of reads. Beside AuditRepository (which is at
// its file-size limit), like auditSummaryQueries.

const auditColumns = {
  id: audits.id,
  status: audits.status,
  startedAt: audits.startedAt,
  completedAt: audits.completedAt,
  pagesCrawled: audits.pagesCrawled,
};

/** The latest completed audit started at or before `cutoff`; when none
 *  completed, the latest one of any status (the caller flags it by status). */
export async function getLatestAuditAtOrBefore(
  projectId: string,
  cutoff: string,
) {
  const inWindow = and(
    eq(audits.projectId, projectId),
    lte(audits.startedAt, cutoff),
  );
  const [completed] = await db
    .select(auditColumns)
    .from(audits)
    .where(and(inWindow, eq(audits.status, "completed")))
    .orderBy(desc(audits.startedAt))
    .limit(1);
  if (completed) return completed;
  const [latest] = await db
    .select(auditColumns)
    .from(audits)
    .where(inWindow)
    .orderBy(desc(audits.startedAt))
    .limit(1);
  return latest ?? null;
}

/** Successful mobile Lighthouse results for an audit, with page URL + depth.
 *  `r2Key` points at the stored payload (the only place TBT is kept).
 *  started_at (SQLite text format) is never used for ordering here; the
 *  service sorts by crawlDepth and url, not by any timestamp. */
export async function getMobileLighthouseForAudit(auditId: string) {
  return db
    .select({
      url: auditPages.url,
      crawlDepth: auditPages.crawlDepth,
      r2Key: auditLighthouseResults.r2Key,
      performanceScore: auditLighthouseResults.performanceScore,
      accessibilityScore: auditLighthouseResults.accessibilityScore,
      bestPracticesScore: auditLighthouseResults.bestPracticesScore,
      seoScore: auditLighthouseResults.seoScore,
      lcpMs: auditLighthouseResults.lcpMs,
      cls: auditLighthouseResults.cls,
      inpMs: auditLighthouseResults.inpMs,
      ttfbMs: auditLighthouseResults.ttfbMs,
    })
    .from(auditLighthouseResults)
    .innerJoin(auditPages, eq(auditLighthouseResults.pageId, auditPages.id))
    .where(
      and(
        eq(auditLighthouseResults.auditId, auditId),
        eq(auditLighthouseResults.strategy, "mobile"),
        isNull(auditLighthouseResults.errorMessage),
      ),
    );
}
