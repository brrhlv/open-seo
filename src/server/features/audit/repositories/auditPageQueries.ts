import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { auditIssues, auditLighthouseResults, auditPages } from "@/db/schema";

// CLIENT-SBLV-194: per-page reads for the public summary's auditPages
// section. Beside AuditRepository (at its file-size limit), like
// auditSummaryQueries and auditReportQueries.

export async function getPageRowsForAudit(auditId: string) {
  return db
    .select({
      id: auditPages.id,
      url: auditPages.url,
      statusCode: auditPages.statusCode,
    })
    .from(auditPages)
    .where(eq(auditPages.auditId, auditId));
}

export async function getIssueRowsForAudit(auditId: string) {
  return db
    .select({
      pageUrl: auditIssues.pageUrl,
      issueType: auditIssues.issueType,
      severity: auditIssues.severity,
      detailsJson: auditIssues.detailsJson,
    })
    .from(auditIssues)
    .where(eq(auditIssues.auditId, auditId));
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
