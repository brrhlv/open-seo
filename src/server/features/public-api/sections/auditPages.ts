import { sortBy } from "remeda";
import { z } from "zod";
import {
  getIssueRowsForAudit,
  getLighthouseRowsForAudit,
  getPageRowsForAudit,
} from "@/server/features/audit/repositories/auditPageQueries";
import { getLatestAuditAtOrBefore } from "@/server/features/audit/repositories/auditReportQueries";
import { getCached, setCached } from "@/server/lib/r2-cache";
import { toIsoTimestamp } from "../timestamps";

// CLIENT-SBLV-194: per-URL issues and Lighthouse scores from the latest
// audit (completed preferred). D1 only, grouped and limited in SQL. A
// completed audit never changes, so its shaped section is cached in R2 by
// audit id; bump CACHE_VERSION when the shape changes.

const PAGE_LIMIT = 250;
const CACHE_VERSION = "v1";
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const SEVERITIES = ["critical", "warning", "info"] as const;
type Severity = (typeof SEVERITIES)[number];
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const cacheKey = (auditId: string) =>
  `public-summary:audit-pages:${CACHE_VERSION}:${auditId}`;

const scoresSchema = z
  .object({
    performance: z.number().nullable(),
    accessibility: z.number().nullable(),
    bestPractices: z.number().nullable(),
    seo: z.number().nullable(),
    lcpMs: z.number().nullable(),
    cls: z.number().nullable(),
    inpMs: z.number().nullable(),
    ttfbMs: z.number().nullable(),
  })
  .nullable();
const sectionSchema = z.object({
  status: z.string(),
  auditId: z.string(),
  capturedAt: z.string().nullable(),
  pagesCrawled: z.number(),
  hasLighthouse: z.boolean(),
  truncated: z.boolean(),
  pages: z.array(
    z.object({
      url: z.string(),
      statusCode: z.number().nullable(),
      issueCounts: z.object({
        critical: z.number(),
        warning: z.number(),
        info: z.number(),
      }),
      issues: z.array(
        z.object({
          issueType: z.string(),
          severity: z.enum(SEVERITIES),
          occurrences: z.number(),
          details: z.record(z.string(), z.unknown()).nullable(),
        }),
      ),
      lighthouse: z
        .object({ mobile: scoresSchema, desktop: scoresSchema })
        .nullable(),
    }),
  ),
});
type AuditPagesSection = z.infer<typeof sectionSchema>;

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

async function build(audit: {
  id: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  pagesCrawled: number;
}): Promise<AuditPagesSection> {
  const [pageRows, issueRows, lighthouseRows] = await Promise.all([
    // One past the limit tells whether the list was cut.
    getPageRowsForAudit(audit.id, PAGE_LIMIT + 1),
    getIssueRowsForAudit(audit.id),
    getLighthouseRowsForAudit(audit.id),
  ]);
  const pages = pageRows.slice(0, PAGE_LIMIT);
  const kept = new Set(pages.map((page) => page.url));
  const issuesByUrl = new Map<
    string,
    AuditPagesSection["pages"][number]["issues"]
  >();
  for (const row of issueRows) {
    if (!kept.has(row.pageUrl)) continue;
    const list = issuesByUrl.get(row.pageUrl) ?? [];
    list.push({
      issueType: row.issueType,
      severity: row.severity,
      occurrences: row.occurrences,
      details: parseDetails(row.detailsJson),
    });
    issuesByUrl.set(row.pageUrl, list);
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
  return {
    status: audit.status,
    auditId: audit.id,
    capturedAt: toIsoTimestamp(audit.completedAt ?? audit.startedAt),
    pagesCrawled: audit.pagesCrawled,
    hasLighthouse: lighthouseRows.length > 0,
    truncated: pageRows.length > PAGE_LIMIT,
    // Already worst-first from SQL.
    pages: pages.map((page) => {
      const lighthouse = lighthouseByPage.get(page.id);
      return {
        url: page.url,
        statusCode: page.statusCode,
        issueCounts: {
          critical: page.critical,
          warning: page.warning,
          info: page.info,
        },
        issues: sortBy(
          issuesByUrl.get(page.url) ?? [],
          (issue) => SEVERITY_ORDER[issue.severity],
          (issue) => issue.issueType,
        ),
        lighthouse: lighthouse
          ? {
              mobile: scores(lighthouse.mobile),
              desktop: scores(lighthouse.desktop),
            }
          : null,
      };
    }),
  };
}

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
  // Only a completed audit is final; a running one still gains pages.
  const cacheable = audit.status === "completed";
  if (cacheable) {
    const cached = sectionSchema.safeParse(
      await getCached(cacheKey(audit.id)).catch(() => null),
    );
    if (cached.success) return cached.data;
  }
  const section = await build(audit);
  if (cacheable) {
    await setCached(cacheKey(audit.id), section, CACHE_TTL_SECONDS).catch(
      (error: unknown) => {
        console.error("public-summary: audit pages cache write failed", error);
      },
    );
  }
  return section;
}
