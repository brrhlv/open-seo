import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditIssues, auditLighthouseResults, auditPages } from "@/db/schema";

// CLIENT-SBLV-194: per-page reads for the public summary's auditPages
// section. Beside AuditRepository (at its file-size limit), like
// auditSummaryQueries and auditReportQueries. Grouping, counting, ordering
// and the page limit happen in SQL so a large audit costs the Worker little.

/** Distinct issue types of one severity on a page. */
const typesOf = (severity: "critical" | "warning" | "info") =>
  sql<number>`count(distinct case when ${auditIssues.severity} = ${severity} then ${auditIssues.issueType} end)`
    .mapWith(Number)
    .as(severity);

/** Crawled pages with their issue-type counts, worst first, at most `limit`. */
export async function getPageRowsForAudit(auditId: string, limit: number) {
  const counts = db
    .select({
      pageUrl: auditIssues.pageUrl,
      critical: typesOf("critical"),
      warning: typesOf("warning"),
      info: typesOf("info"),
    })
    .from(auditIssues)
    .where(eq(auditIssues.auditId, auditId))
    .groupBy(auditIssues.pageUrl)
    .as("counts");
  const count = (column: typeof counts.critical) =>
    sql<number>`coalesce(${column}, 0)`.mapWith(Number);
  return db
    .select({
      id: auditPages.id,
      url: auditPages.url,
      statusCode: auditPages.statusCode,
      critical: count(counts.critical),
      warning: count(counts.warning),
      info: count(counts.info),
    })
    .from(auditPages)
    .leftJoin(counts, eq(counts.pageUrl, auditPages.url))
    .where(eq(auditPages.auditId, auditId))
    .orderBy(
      desc(count(counts.critical)),
      desc(count(counts.warning)),
      desc(count(counts.info)),
      asc(auditPages.url),
    )
    .limit(limit);
}

/** One row per (page, issue type, severity) with its occurrence count and
 *  one row's details (link-level types write a row per occurrence). */
export async function getIssueRowsForAudit(auditId: string) {
  return db
    .select({
      pageUrl: auditIssues.pageUrl,
      issueType: auditIssues.issueType,
      severity: auditIssues.severity,
      occurrences: sql<number>`count(*)`.mapWith(Number),
      detailsJson: sql<string | null>`min(${auditIssues.detailsJson})`,
    })
    .from(auditIssues)
    .where(eq(auditIssues.auditId, auditId))
    .groupBy(auditIssues.pageUrl, auditIssues.issueType, auditIssues.severity);
}

/** Successful Lighthouse results (both strategies) for an audit. */
export async function getLighthouseRowsForAudit(auditId: string) {
  return db
    .select({
      pageId: auditLighthouseResults.pageId,
      strategy: auditLighthouseResults.strategy,
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
    .where(
      and(
        eq(auditLighthouseResults.auditId, auditId),
        isNull(auditLighthouseResults.errorMessage),
      ),
    );
}
