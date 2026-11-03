import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuditPagesSection } from "./auditPages";

const mocks = vi.hoisted(() => ({
  getLatestAuditAtOrBefore: vi.fn(),
  getPageRowsForAudit: vi.fn(),
  getIssueRowsForAudit: vi.fn(),
  getLighthouseRowsForAudit: vi.fn(),
  getCached: vi.fn(),
  setCached: vi.fn(),
}));
vi.mock("@/server/features/audit/repositories/auditReportQueries", () => ({
  getLatestAuditAtOrBefore: mocks.getLatestAuditAtOrBefore,
}));
vi.mock("@/server/features/audit/repositories/auditPageQueries", () => ({
  getPageRowsForAudit: mocks.getPageRowsForAudit,
  getIssueRowsForAudit: mocks.getIssueRowsForAudit,
  getLighthouseRowsForAudit: mocks.getLighthouseRowsForAudit,
}));
vi.mock("@/server/lib/r2-cache", () => ({
  getCached: mocks.getCached,
  setCached: mocks.setCached,
}));

const NOW = new Date("2026-11-02T12:00:00.000Z");

const page = (
  id: string,
  url: string,
  critical = 0,
  warning = 0,
  info = 0,
) => ({
  id,
  url,
  statusCode: 200,
  critical,
  warning,
  info,
});
const issue = (
  pageUrl: string,
  issueType: string,
  severity: string,
  occurrences = 1,
  detailsJson: string | null = null,
) => ({ pageUrl, issueType, severity, occurrences, detailsJson });

const AUDIT = {
  id: "a1",
  status: "completed",
  startedAt: "2026-09-05 00:51:55",
  completedAt: "2026-09-05T00:52:05.096Z",
  pagesCrawled: 3,
};

describe("getAuditPagesSection", () => {
  beforeEach(() => {
    mocks.getCached.mockResolvedValue(null);
    mocks.setCached.mockResolvedValue(undefined);
    mocks.getLatestAuditAtOrBefore.mockResolvedValue(AUDIT);
    // Worst first, as the SQL returns them.
    mocks.getPageRowsForAudit.mockResolvedValue([
      page("p-bad", "https://a.com/services", 1, 0, 1),
      page("p-home", "https://a.com/", 0, 0, 1),
      page("p-clean", "https://a.com/about"),
    ]);
    mocks.getIssueRowsForAudit.mockResolvedValue([
      issue("https://a.com/", "title-too-long", "info", 1, '{"length":181}'),
      issue("https://a.com/services", "title-too-long", "info", 1, "not json"),
      issue(
        "https://a.com/services",
        "broken-internal-link",
        "critical",
        2,
        '{"target":"/x"}',
      ),
    ]);
    mocks.getLighthouseRowsForAudit.mockResolvedValue([
      {
        pageId: "p-home",
        strategy: "mobile",
        performanceScore: 71,
        accessibilityScore: 96,
        bestPracticesScore: 100,
        seoScore: 100,
        lcpMs: 3100,
        cls: 0.02,
        inpMs: null,
        ttfbMs: 410,
      },
    ]);
  });

  it("shapes pages with their issues and Lighthouse per strategy, and caches a completed audit", async () => {
    const section = await getAuditPagesSection("proj", NOW);
    expect(mocks.getPageRowsForAudit).toHaveBeenCalledWith("a1", 251);
    expect(section).toMatchObject({
      status: "completed",
      auditId: "a1",
      capturedAt: "2026-09-05T00:52:05.096Z",
      hasLighthouse: true,
      truncated: false,
    });
    expect(section.pages.map((p) => p.url)).toEqual([
      "https://a.com/services",
      "https://a.com/",
      "https://a.com/about",
    ]);
    expect(section.pages[0]).toMatchObject({
      issueCounts: { critical: 1, warning: 0, info: 1 },
      issues: [
        {
          issueType: "broken-internal-link",
          severity: "critical",
          occurrences: 2,
          details: { target: "/x" },
        },
        { issueType: "title-too-long", occurrences: 1, details: null },
      ],
      lighthouse: null,
    });
    expect(section.pages[1]?.lighthouse).toEqual({
      mobile: {
        performance: 71,
        accessibility: 96,
        bestPractices: 100,
        seo: 100,
        lcpMs: 3100,
        cls: 0.02,
        inpMs: null,
        ttfbMs: 410,
      },
      desktop: null,
    });
    expect(section.pages[2]).toMatchObject({ issues: [] });
    expect(mocks.setCached).toHaveBeenCalledWith(
      "public-summary:audit-pages:v1:a1",
      section,
      30 * 24 * 60 * 60,
    );
  });

  it("serves a cached completed audit without reading its pages", async () => {
    const cached = await getAuditPagesSection("proj", NOW);
    mocks.getPageRowsForAudit.mockClear();
    mocks.getCached.mockResolvedValue(cached);
    expect(await getAuditPagesSection("proj", NOW)).toEqual(cached);
    expect(mocks.getPageRowsForAudit).not.toHaveBeenCalled();
  });

  it("never caches a running audit, and flags a cut list", async () => {
    mocks.getLatestAuditAtOrBefore.mockResolvedValue({
      ...AUDIT,
      status: "running",
    });
    mocks.getPageRowsForAudit.mockResolvedValue(
      Array.from({ length: 251 }, (_, i) =>
        page(`p${i}`, `https://a.com/${i}`),
      ),
    );
    const section = await getAuditPagesSection("proj", NOW);
    expect(section).toMatchObject({ status: "running", truncated: true });
    expect(section.pages).toHaveLength(250);
    expect(mocks.getCached).not.toHaveBeenCalled();
    expect(mocks.setCached).not.toHaveBeenCalled();
  });

  it("reports status none before the first audit", async () => {
    mocks.getLatestAuditAtOrBefore.mockResolvedValue(null);
    expect(await getAuditPagesSection("proj", NOW)).toMatchObject({
      status: "none",
      capturedAt: null,
      pages: [],
    });
  });
});
