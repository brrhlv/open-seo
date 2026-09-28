import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ga4ReportError } from "@/server/lib/ga4Errors";
import { GscApiError, GscNotConnectedError } from "@/server/lib/gscErrors";
import { PublicSummaryService } from "./PublicSummaryService";

const mocks = vi.hoisted(() => ({
  getProjectWithOrganization: vi.fn(),
  getConfigsForProject: vi.fn(),
  getLatestResults: vi.fn(),
  getBacklinkSummary: vi.fn(),
  getLatestAuditForProject: vi.fn(),
  getIssueTypePageCountsForAudit: vi.fn(),
  getPerformance: vi.fn(),
  getOrganicOverview: vi.fn(),
  runReport: vi.fn(),
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectWithOrganization: mocks.getProjectWithOrganization,
  },
}));
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getConfigsForProject: mocks.getConfigsForProject,
    },
  }),
);
vi.mock("@/server/features/rank-tracking/services/rankTrackingResults", () => ({
  getLatestResults: mocks.getLatestResults,
}));
vi.mock("@/server/features/dashboard/services/DashboardService", () => ({
  DashboardService: { getBacklinkSummary: mocks.getBacklinkSummary },
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    getLatestAuditForProject: mocks.getLatestAuditForProject,
  },
}));
vi.mock("@/server/features/audit/repositories/auditSummaryQueries", () => ({
  getIssueTypePageCountsForAudit: mocks.getIssueTypePageCountsForAudit,
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance: mocks.getPerformance },
}));
vi.mock("@/server/features/ga4/services/Ga4OrganicOverviewService", () => ({
  Ga4OrganicOverviewService: {
    getOrganicOverview: mocks.getOrganicOverview,
  },
}));
vi.mock("@/server/features/ga4/services/Ga4ReportingService", () => ({
  Ga4ReportingService: { runReport: mocks.runReport },
}));

const NOW = new Date("2026-09-28T12:00:00Z");
const input = { projectId: "proj-a", range: "last_28_days", now: NOW } as const;

describe("PublicSummaryService.getSummary", () => {
  beforeEach(() => {
    mocks.getProjectWithOrganization.mockResolvedValue({
      organizationId: "org-1",
      project: { id: "proj-a", domain: "socialboothlv.com" },
    });
    mocks.getConfigsForProject.mockResolvedValue([]);
    mocks.getBacklinkSummary.mockResolvedValue(null);
    mocks.getLatestAuditForProject.mockResolvedValue(undefined);
    mocks.getPerformance.mockRejectedValue(new GscNotConnectedError("proj-a"));
    mocks.getOrganicOverview.mockRejectedValue(
      new Ga4ReportError("ga4_not_connected", "not connected"),
    );
    mocks.runReport.mockRejectedValue(
      new Ga4ReportError("ga4_not_connected", "not connected"),
    );
  });

  it("returns null for an unknown or archived project", async () => {
    mocks.getProjectWithOrganization.mockResolvedValue(null);
    expect(await PublicSummaryService.getSummary(input)).toBeNull();
  });

  it("reports unlinked GSC/GA4 as connected:false and empty D1 sections as zeros", async () => {
    expect(await PublicSummaryService.getSummary(input)).toEqual({
      project: { id: "proj-a", domain: "socialboothlv.com" },
      generatedAt: "2026-09-28T12:00:00.000Z",
      range: { start: "2026-08-29", end: "2026-09-25" },
      rankings: {
        trackedKeywords: 0,
        top10: 0,
        improved: 0,
        declined: 0,
        lastCheckedAt: null,
        keywords: [],
        comparedTo: "30d",
      },
      backlinks: {
        backlinks: 0,
        referringDomains: 0,
        rank: 0,
        capturedAt: null,
      },
      audit: {
        status: "none",
        pagesCrawled: 0,
        startedAt: null,
        issuesBySeverity: { critical: 0, warning: 0, info: 0 },
      },
      gsc: { connected: false },
      ga4: { connected: false },
    });
  });

  it("turns a failing section into an error code without failing the others", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getPerformance.mockRejectedValue(new GscApiError(500, "boom"));
    mocks.getBacklinkSummary.mockRejectedValue(new Error("d1 down"));
    mocks.getOrganicOverview.mockRejectedValue(
      new Ga4ReportError("ga4_quota_exhausted", "quota"),
    );
    mocks.runReport.mockResolvedValue({ rows: [] });

    expect(await PublicSummaryService.getSummary(input)).toMatchObject({
      gsc: { error: "gsc_upstream_unavailable" },
      backlinks: { error: "internal_error" },
      ga4: { error: "ga4_quota_exhausted" },
      audit: { status: "none" },
    });
  });

  it("shapes rankings, backlinks, audit, GSC and GA4 data", async () => {
    mocks.getConfigsForProject.mockResolvedValue([{ id: "cfg-1" }]);
    mocks.getLatestResults.mockResolvedValue({
      rows: [
        {
          keyword: "photo booth rental las vegas",
          desktop: { position: null, previousPosition: null, rankingUrl: null },
          mobile: {
            position: 4,
            previousPosition: 7,
            rankingUrl: "https://socialboothlv.com/",
          },
        },
      ],
      run: { lastCheckedAt: "2026-09-27 06:00:00" },
    });
    mocks.getBacklinkSummary.mockResolvedValue({
      rank: 12,
      backlinks: 340,
      referringDomains: 55,
      capturedAt: "2026-09-27T08:00:00.000Z",
    });
    mocks.getLatestAuditForProject.mockResolvedValue({
      id: "audit-1",
      status: "completed",
      pagesCrawled: 40,
      startedAt: "2026-09-20 10:00:00",
    });
    mocks.getIssueTypePageCountsForAudit.mockResolvedValue([
      { severity: "critical", pages: 2 },
      { severity: "critical", pages: 1 },
      { severity: "info", pages: 5 },
    ]);
    mocks.getPerformance.mockImplementation(
      async ({ dimensions }: { dimensions: string[] }) => ({
        rows: [
          {
            keys: [dimensions[0] === "query" ? "photo booth" : "2026-09-24"],
            clicks: 3,
            impressions: 100,
            ctr: 0.03,
            position: 8,
          },
        ],
      }),
    );
    mocks.getOrganicOverview.mockResolvedValue({
      current: {
        sessions: 50,
        activeUsers: 40,
        engagementRate: 0.6,
        keyEvents: 2,
      },
      previous: {
        sessions: 40,
        activeUsers: 30,
        engagementRate: 0.5,
        keyEvents: 1,
      },
      trend: [{ date: "20260924", sessions: 5 }],
    });
    mocks.runReport.mockResolvedValue({
      rows: [{ sessionSourceMedium: "google / organic", sessions: 30 }],
    });

    const summary = await PublicSummaryService.getSummary(input);

    expect(mocks.getLatestResults).toHaveBeenCalledWith(
      "cfg-1",
      "proj-a",
      "30d",
    );
    expect(mocks.runReport).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "traffic_acquisition",
        acquisitionBreakdown: "source_medium",
        channel: "all",
        startDate: "2026-08-29",
        endDate: "2026-09-25",
      }),
    );
    expect(summary).toMatchObject({
      rankings: {
        trackedKeywords: 1,
        top10: 1,
        improved: 1,
        declined: 0,
        lastCheckedAt: "2026-09-27T06:00:00.000Z",
        comparedTo: "30d",
        keywords: [
          {
            keyword: "photo booth rental las vegas",
            device: "mobile",
            position: 4,
            previousPosition: 7,
            url: "https://socialboothlv.com/",
          },
        ],
      },
      backlinks: {
        backlinks: 340,
        referringDomains: 55,
        rank: 12,
        capturedAt: "2026-09-27T08:00:00.000Z",
      },
      audit: {
        status: "completed",
        pagesCrawled: 40,
        startedAt: "2026-09-20T10:00:00.000Z",
        issuesBySeverity: { critical: 3, warning: 0, info: 5 },
      },
      gsc: {
        connected: true,
        totals: { clicks: 3, impressions: 100, ctr: 0.03, position: 8 },
        prevTotals: { clicks: 3, impressions: 100, ctr: 0.03, position: 8 },
        daily: [{ date: "2026-09-24", clicks: 3, impressions: 100 }],
        topQueries: [
          {
            query: "photo booth",
            clicks: 3,
            impressions: 100,
            ctr: 0.03,
            position: 8,
          },
        ],
      },
      ga4: {
        connected: true,
        totals: {
          sessions: 50,
          activeUsers: 40,
          engagementRate: 0.6,
          keyEvents: 2,
        },
        prevTotals: {
          sessions: 40,
          activeUsers: 30,
          engagementRate: 0.5,
          keyEvents: 1,
        },
        daily: [{ date: "2026-09-24", sessions: 5 }],
        sources: [{ source: "google", medium: "organic", sessions: 30 }],
      },
    });
  });
});
