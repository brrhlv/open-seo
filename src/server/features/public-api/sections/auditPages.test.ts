import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuditPagesSection } from "./auditPages";

const mocks = vi.hoisted(() => ({
  getLatestAuditAtOrBefore: vi.fn(),
  getPageRowsForAudit: vi.fn(),
  getIssueRowsForAudit: vi.fn(),
  getLighthouseRowsForAudit: vi.fn(),
}));
vi.mock("@/server/features/audit/repositories/auditReportQueries", () => ({
  getLatestAuditAtOrBefore: mocks.getLatestAuditAtOrBefore,
}));
vi.mock("@/server/features/audit/repositories/auditPageQueries", () => ({
  getPageRowsForAudit: mocks.getPageRowsForAudit,
  getIssueRowsForAudit: mocks.getIssueRowsForAudit,
  getLighthouseRowsForAudit: mocks.getLighthouseRowsForAudit,
}));

const NOW = new Date("2026-11-02T12:00:00.000Z");

function issue(
  pageUrl: string,
  issueType: string,
  severity: string,
  detailsJson: string | null = null,
) {
  return { pageUrl, issueType, severity, detailsJson };
}

describe("getAuditPagesSection", () => {
  beforeEach(() => {
    mocks.getLatestAuditAtOrBefore.mockResolvedValue({
      id: "a1",
      status: "completed",
      startedAt: "2026-09-05 00:51:55",
      completedAt: "2026-09-05T00:52:05.096Z",
      pagesCrawled: 3,
    });
    mocks.getPageRowsForAudit.mockResolvedValue([
      { id: "p-home", url: "https://a.com/", statusCode: 200 },
      { id: "p-clean", url: "https://a.com/about", statusCode: 200 },
      { id: "p-bad", url: "https://a.com/services", statusCode: 200 },
    ]);
    mocks.getIssueRowsForAudit.mockResolvedValue([
      issue("https://a.com/", "title-too-long", "info", '{"length":181}'),
      issue(
        "https://a.com/services",
        "broken-link",
        "critical",
        '{"target":"/x"}',
      ),
      issue(
        "https://a.com/services",
        "broken-link",
        "critical",
        '{"target":"/y"}',
      ),
      issue(
        "https://a.com/services",
        "meta-description-too-long",
        "info",
        "not json",
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

  it("groups issues per page, worst pages first, with Lighthouse per strategy", async () => {
    const section = await getAuditPagesSection("proj", NOW);
    expect(mocks.getLatestAuditAtOrBefore).toHaveBeenCalledWith(
      "proj",
      NOW.toISOString(),
    );
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
          issueType: "broken-link",
          severity: "critical",
          occurrences: 2,
          details: { target: "/x" },
        },
        {
          issueType: "meta-description-too-long",
          severity: "info",
          occurrences: 1,
          details: null,
        },
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
    expect(section.pages[2]).toMatchObject({
      issues: [],
      issueCounts: { critical: 0, warning: 0, info: 0 },
    });
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
