import { sortBy } from "remeda";
import {
  getLatestAuditAtOrBefore,
  getMobileLighthouseForAudit,
} from "@/server/features/audit/repositories/auditReportQueries";
import { getIssueTypePageCountsForAudit } from "@/server/features/audit/repositories/auditSummaryQueries";
import {
  endOfDayCutoff,
  toIsoTimestamp,
} from "@/server/features/public-api/timestamps";
import { readStoredLighthousePayload } from "@/server/lib/lighthousePayload";
import { getJsonFromR2 } from "@/server/lib/r2";
import { ReportApiError } from "./reportErrors";
import { requireDateParam, type ReportContext } from "./reportRequest";

const TOP_ISSUE_LIMIT = 10;
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

type LighthouseRow = Awaited<
  ReturnType<typeof getMobileLighthouseForAudit>
>[number];

function isHomepage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" && parsed.search === "";
  } catch {
    return false;
  }
}

/** Total Blocking Time (ms) from the stored v2 payload in R2 — the table has
 *  no TBT column. Any miss (no key, no object, legacy/invalid payload) is
 *  null; it never fails R7. */
async function readTbtMs(r2Key: string | null): Promise<number | null> {
  if (!r2Key) return null;
  try {
    const { storedPayload } = readStoredLighthousePayload(
      await getJsonFromR2(r2Key),
    );
    return storedPayload?.metrics.totalBlockingTime.numericValue ?? null;
  } catch {
    return null;
  }
}

/** The homepage's mobile result, else the shallowest page's, else null. */
async function pickLighthouse(rows: LighthouseRow[]) {
  const row =
    rows.find((candidate) => isHomepage(candidate.url)) ??
    sortBy(
      rows,
      (candidate) => candidate.crawlDepth ?? Number.MAX_SAFE_INTEGER,
      (candidate) => candidate.url,
    )[0];
  if (!row) return null;
  const tbtMs = await readTbtMs(row.r2Key);
  return {
    url: row.url,
    strategy: "mobile" as const,
    performance: row.performanceScore,
    accessibility: row.accessibilityScore,
    bestPractices: row.bestPracticesScore,
    seo: row.seoScore,
    lcpMs: row.lcpMs,
    cls: row.cls,
    inpMs: row.inpMs,
    ttfbMs: row.ttfbMs,
    tbtMs,
  };
}

/** R7: the latest audit started by asOf (completed preferred). */
async function getAudit({ project, request }: ReportContext) {
  const asOf = requireDateParam(request, "asOf");
  const audit = await getLatestAuditAtOrBefore(
    project.id,
    endOfDayCutoff(asOf),
  );
  if (!audit) throw new ReportApiError(409, "no_audit");

  const [issueRows, lighthouseRows] = await Promise.all([
    getIssueTypePageCountsForAudit(audit.id),
    getMobileLighthouseForAudit(audit.id),
  ]);
  // Sum of per-issue-type distinct-page counts (a page with two warning types
  // counts twice) — not distinct pages per severity. Same as the PAI-222
  // summary; spec deviation 16.
  const issuesBySeverity = { critical: 0, warning: 0, info: 0 };
  for (const row of issueRows) issuesBySeverity[row.severity] += row.pages;
  const topIssues = sortBy(
    issueRows,
    (row) => SEVERITY_ORDER[row.severity],
    [(row) => row.pages, "desc"],
    (row) => row.issueType,
  )
    .slice(0, TOP_ISSUE_LIMIT)
    .map(({ issueType, severity, pages }) => ({ issueType, severity, pages }));

  return {
    auditId: audit.id,
    status: audit.status,
    startedAt: toIsoTimestamp(audit.startedAt),
    completedAt: toIsoTimestamp(audit.completedAt),
    pagesCrawled: audit.pagesCrawled,
    issuesBySeverity,
    topIssues,
    lighthouse: await pickLighthouse(lighthouseRows),
  };
}

export const ReportAuditService = { getAudit };
