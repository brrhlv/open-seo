import { sortBy } from "remeda";
import {
  getIssueRowsForAudit,
  getLighthouseRowsForAudit,
  getPageRowsForAudit,
} from "@/server/features/audit/repositories/auditPageQueries";
import { getLatestAuditAtOrBefore } from "@/server/features/audit/repositories/auditReportQueries";
import { toIsoTimestamp } from "../timestamps";

// CLIENT-SBLV-194: per-URL issues and Lighthouse scores from the latest
// audit (completed preferred). D1 only.

const PAGE_LIMIT = 250;
const SEVERITIES = ["critical", "warning", "info"] as const;
type Severity = (typeof SEVERITIES)[number];
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

type LighthouseRow = Awaited<
  ReturnType<typeof getLighthouseRowsForAudit>
>[number];

function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : null;
  } catch {
    return null;
  }
}

function scores(row: LighthouseRow | undefined) {
  if (!row) return null;
  return {
    performance: row.performanceScore,
    accessibility: row.accessibilityScore,
    bestPractices: row.bestPracticesScore,
    seo: row.seoScore,
    lcpMs: row.lcpMs,
    cls: row.cls,
    inpMs: row.inpMs,
    ttfbMs: row.ttfbMs,
  };
}

type PageIssue = {
  issueType: string;
  severity: Severity;
  // Link-level issue types write one row per occurrence.
  occurrences: number;
  details: Record<string, unknown> | null;
};

export async function getAuditPagesSection(projectId: string, now: Date) {
  const audit = await getLatestAuditAtOrBefore(projectId, now.toISOString());
  if (!audit) {
    return {
      status: "none" as const,
      auditId: null,
      capturedAt: null,
      pagesCrawled: 0,
      hasLighthouse: false,
      truncated: false,
      pages: [],
    };
  }
  const [pageRows, issueRows, lighthouseRows] = await Promise.all([
    getPageRowsForAudit(audit.id),
    getIssueRowsForAudit(audit.id),
    getLighthouseRowsForAudit(audit.id),
  ]);

  const issuesByUrl = new Map<string, Map<string, PageIssue>>();
  for (const row of issueRows) {
    const byType = issuesByUrl.get(row.pageUrl) ?? new Map<string, PageIssue>();
    issuesByUrl.set(row.pageUrl, byType);
    const key = `${row.severity}:${row.issueType}`;
    const existing = byType.get(key);
    if (existing) existing.occurrences++;
    else {
      byType.set(key, {
        issueType: row.issueType,
        severity: row.severity,
        occurrences: 1,
        details: parseDetails(row.detailsJson),
      });
    }
  }
  const lighthouseByPage = new Map<
    string,
    Partial<Record<"mobile" | "desktop", LighthouseRow>>
  >();
  for (const row of lighthouseRows) {
    const entry = lighthouseByPage.get(row.pageId) ?? {};
    entry[row.strategy] = row;
    lighthouseByPage.set(row.pageId, entry);
  }

  const pages = pageRows.map((page) => {
    const issues = sortBy(
      [...(issuesByUrl.get(page.url)?.values() ?? [])],
      (issue) => SEVERITY_ORDER[issue.severity],
      (issue) => issue.issueType,
    );
    const issueCounts = { critical: 0, warning: 0, info: 0 };
    for (const issue of issues) issueCounts[issue.severity]++;
    const lighthouse = lighthouseByPage.get(page.id);
    return {
      url: page.url,
      statusCode: page.statusCode,
      issueCounts,
      issues,
      lighthouse: lighthouse
        ? {
            mobile: scores(lighthouse.mobile),
            desktop: scores(lighthouse.desktop),
          }
        : null,
    };
  });
  const sorted = sortBy(
    pages,
    [(page) => page.issueCounts.critical, "desc"],
    [(page) => page.issueCounts.warning, "desc"],
    [(page) => page.issueCounts.info, "desc"],
    (page) => page.url,
  );

  return {
    status: audit.status,
    auditId: audit.id,
    capturedAt: toIsoTimestamp(audit.completedAt ?? audit.startedAt),
    pagesCrawled: audit.pagesCrawled,
    hasLighthouse: lighthouseRows.length > 0,
    truncated: sorted.length > PAGE_LIMIT,
    pages: sorted.slice(0, PAGE_LIMIT),
  };
}
