import { sort } from "remeda";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { getIssueTypePageCountsForAudit } from "@/server/features/audit/repositories/auditSummaryQueries";
import { DashboardService } from "@/server/features/dashboard/services/DashboardService";
import { Ga4OrganicOverviewService } from "@/server/features/ga4/services/Ga4OrganicOverviewService";
import { Ga4ReportingService } from "@/server/features/ga4/services/Ga4ReportingService";
import {
  previousPeriod,
  sumSearchTotals,
  toDimensionRows,
} from "@/server/features/gsc/searchPerformanceReport";
import { GscService } from "@/server/features/gsc/services/GscService";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { summarizeRankResults } from "@/server/features/rank-tracking/services/rankSummary";
import { getLatestResults } from "@/server/features/rank-tracking/services/rankTrackingResults";
import { Ga4ReportError } from "@/server/lib/ga4Errors";
import {
  GscApiError,
  GscNotConnectedError,
  isExpectedGrantFailure,
} from "@/server/lib/gscErrors";
import {
  RANK_COMPARE_PERIOD,
  resolvePublicSummaryDates,
  type PublicSummaryRange,
} from "./publicSummaryRange";

// Read-only project summary for external dashboards (PAI-222). Every read is
// D1 or first-party Google data — never a DataForSEO-metered path (no
// ensureBacklinkSnapshot, AI visibility, or live SERP/opportunity calls).

// Same bound as the dashboard overview; projects rarely have more configs.
const MAX_CONFIGS = 5;
const KEYWORD_LIMIT = 100;
const TOP_QUERY_LIMIT = 10;
const SOURCE_LIMIT = 10;
// dimensions:["date"] returns one row per day; the longest range is 90 days.
const DAILY_ROW_LIMIT = 200;

type SummaryDates = { start: string; end: string };
type SectionError = { error: string };
type Ga4Row = Record<string, string | number | null> | null | undefined;

/** All UTC dates in [start, end] inclusive (YYYY-MM-DD), for dense fill. */
function dateRange(start: string, end: string): string[] {
  const dayMs = 24 * 60 * 60 * 1000;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const dates: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += dayMs) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

/** GSC daily rows dense-filled with zeros for every date in the window. */
function fillGscDaily(
  rows: { date: string; clicks: number; impressions: number }[],
  dates: SummaryDates,
): { date: string; clicks: number; impressions: number }[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return dateRange(dates.start, dates.end).map((date) => ({
    date,
    clicks: byDate.get(date)?.clicks ?? 0,
    impressions: byDate.get(date)?.impressions ?? 0,
  }));
}

/** GA4 daily rows dense-filled with zeros for every date in the window. */
function fillGa4Daily(
  rows: { date: string; sessions: number }[],
  dates: SummaryDates,
): { date: string; sessions: number }[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return dateRange(dates.start, dates.end).map((date) => ({
    date,
    sessions: byDate.get(date)?.sessions ?? 0,
  }));
}

/** SQLite defaults store "YYYY-MM-DD HH:MM:SS" (UTC); Postgres and app writes
 *  store ISO. The wire contract is ISO. */
function toIsoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/** GA4 `date` dimension values are YYYYMMDD. */
function toIsoDate(value: string): string {
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`
    : value;
}

function metric(value: string | number | null | undefined): number {
  return typeof value === "number" ? value : 0;
}

function ga4Totals(row: Ga4Row) {
  return {
    sessions: metric(row?.sessions),
    activeUsers: metric(row?.activeUsers),
    engagementRate: metric(row?.engagementRate),
    keyEvents: metric(row?.keyEvents),
  };
}

/** GA4 sessionSourceMedium is "source / medium". */
function splitSourceMedium(value: string): { source: string; medium: string } {
  const separator = value.indexOf(" / ");
  return separator < 0
    ? { source: value, medium: "" }
    : { source: value.slice(0, separator), medium: value.slice(separator + 3) };
}

function sectionErrorCode(error: unknown): string {
  if (error instanceof Ga4ReportError) return error.code;
  if (error instanceof GscApiError) {
    return error.status === 429
      ? "gsc_quota_exhausted"
      : "gsc_upstream_unavailable";
  }
  return "internal_error";
}

function unwrap<T>(
  section: string,
  projectId: string,
  result: PromiseSettledResult<T>,
): T | SectionError {
  if (result.status === "fulfilled") return result.value;
  console.error(
    `public-summary: ${section} section failed`,
    { projectId },
    result.reason,
  );
  return { error: sectionErrorCode(result.reason) };
}

async function getRankings(projectId: string, range: PublicSummaryRange) {
  const configs = await RankTrackingRepository.getConfigsForProject(projectId);
  const results = await Promise.all(
    configs
      .slice(0, MAX_CONFIGS)
      .map((config) =>
        getLatestResults(config.id, projectId, RANK_COMPARE_PERIOD[range]),
      ),
  );
  const summary = summarizeRankResults(results);
  const keywords = results
    .flatMap((result) => result.rows)
    .flatMap((row) =>
      (["desktop", "mobile"] as const)
        .filter(
          (device) =>
            row[device].position !== null ||
            row[device].previousPosition !== null,
        )
        .map((device) => ({
          keyword: row.keyword,
          device,
          position: row[device].position,
          previousPosition: row[device].previousPosition,
          url: row[device].rankingUrl,
        })),
    );
  const unranked = Number.MAX_SAFE_INTEGER;
  return {
    ...summary,
    lastCheckedAt: toIsoTimestamp(summary.lastCheckedAt),
    // The compare baseline used, so the consumer can surface it.
    comparedTo: RANK_COMPARE_PERIOD[range],
    // Best rank first; keywords that dropped out of the results (null) last.
    keywords: sort(
      keywords,
      (a, b) => (a.position ?? unranked) - (b.position ?? unranked),
    ).slice(0, KEYWORD_LIMIT),
  };
}

async function getBacklinks(projectId: string, domain: string | null) {
  // Stored snapshot only — refreshing it (ensureBacklinkSnapshot) is metered.
  const summary = await DashboardService.getBacklinkSummary(projectId, domain);
  return {
    backlinks: summary?.backlinks ?? 0,
    referringDomains: summary?.referringDomains ?? 0,
    rank: summary?.rank ?? 0,
    capturedAt: toIsoTimestamp(summary?.capturedAt),
  };
}

async function getAudit(projectId: string) {
  const issuesBySeverity = { critical: 0, warning: 0, info: 0 };
  const audit = await AuditRepository.getLatestAuditForProject(projectId);
  if (!audit) {
    return {
      status: "none" as const,
      pagesCrawled: 0,
      startedAt: null,
      issuesBySeverity,
    };
  }
  const typeRows = await getIssueTypePageCountsForAudit(audit.id);
  for (const row of typeRows) issuesBySeverity[row.severity] += row.pages;
  return {
    status: audit.status,
    pagesCrawled: audit.pagesCrawled,
    startedAt: toIsoTimestamp(audit.startedAt),
    issuesBySeverity,
  };
}

async function getGsc(projectId: string, dates: SummaryDates) {
  const prev = previousPeriod(dates.start, dates.end);
  try {
    const [current, previous, queries] = await Promise.all([
      GscService.getPerformance({
        projectId,
        startDate: dates.start,
        endDate: dates.end,
        dimensions: ["date"],
        rowLimit: DAILY_ROW_LIMIT,
      }),
      GscService.getPerformance({
        projectId,
        startDate: prev.startDate,
        endDate: prev.endDate,
        dimensions: ["date"],
        rowLimit: DAILY_ROW_LIMIT,
      }),
      GscService.getPerformance({
        projectId,
        startDate: dates.start,
        endDate: dates.end,
        dimensions: ["query"],
        rowLimit: TOP_QUERY_LIMIT,
      }),
    ]);
    const rawDaily = current.rows.flatMap((row) => {
      const date = row.keys?.[0];
      return date
        ? [{ date, clicks: row.clicks, impressions: row.impressions }]
        : [];
    });
    return {
      connected: true as const,
      totals: sumSearchTotals(current.rows),
      prevTotals: sumSearchTotals(previous.rows),
      daily: fillGscDaily(rawDaily, dates),
      topQueries: toDimensionRows(queries.rows).map(({ key, ...values }) => ({
        query: key,
        ...values,
      })),
    };
  } catch (error) {
    // Unlinked, or a dead/denied grant: the same "connect" state the in-app
    // Search Performance page shows (searchPerformance.ts).
    if (
      error instanceof GscNotConnectedError ||
      isExpectedGrantFailure(error)
    ) {
      return { connected: false as const };
    }
    throw error;
  }
}

async function getGa4(projectId: string, dates: SummaryDates) {
  try {
    const [overview, sources] = await Promise.all([
      // Organic Search only (the SEO lens).
      Ga4OrganicOverviewService.getOrganicOverview({
        projectId,
        startDate: dates.start,
        endDate: dates.end,
        trend: "daily",
      }),
      // All channels, so the consumer can see where traffic comes from.
      Ga4ReportingService.runReport({
        projectId,
        kind: "traffic_acquisition",
        acquisitionBreakdown: "source_medium",
        channel: "all",
        startDate: dates.start,
        endDate: dates.end,
        limit: SOURCE_LIMIT,
      }),
    ]);
    return {
      connected: true as const,
      totals: ga4Totals(overview.current),
      prevTotals: ga4Totals(overview.previous),
      daily: fillGa4Daily(
        overview.trend.map((row) => ({
          date: toIsoDate(String(row.date ?? "")),
          sessions: metric(row.sessions),
        })),
        dates,
      ),
      sources: sources.rows.map((row) => ({
        ...splitSourceMedium(String(row.sessionSourceMedium ?? "")),
        sessions: metric(row.sessions),
      })),
    };
  } catch (error) {
    if (error instanceof Ga4ReportError && error.code === "ga4_not_connected") {
      return { connected: false as const };
    }
    throw error;
  }
}

async function getSummary(input: {
  projectId: string;
  range: PublicSummaryRange;
  now?: Date;
}) {
  const found = await ProjectService.getProjectWithOrganization(
    input.projectId,
  );
  if (!found) return null;
  const { project } = found;
  const now = input.now ?? new Date();
  const dates = resolvePublicSummaryDates(input.range, now);

  const [rankings, backlinks, audit, gsc, ga4] = await Promise.allSettled([
    getRankings(project.id, input.range),
    getBacklinks(project.id, project.domain),
    getAudit(project.id),
    getGsc(project.id, dates),
    getGa4(project.id, dates),
  ]);

  return {
    project: { id: project.id, domain: project.domain },
    generatedAt: now.toISOString(),
    range: dates,
    rankings: unwrap("rankings", project.id, rankings),
    backlinks: unwrap("backlinks", project.id, backlinks),
    audit: unwrap("audit", project.id, audit),
    gsc: unwrap("gsc", project.id, gsc),
    ga4: unwrap("ga4", project.id, ga4),
  };
}

export const PublicSummaryService = { getSummary };
