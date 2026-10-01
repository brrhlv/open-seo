import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportAuditService } from "./reportAuditService";

const mocks = vi.hoisted(() => ({
  getLatestAuditAtOrBefore: vi.fn(),
  getMobileLighthouseForAudit: vi.fn(),
  getIssueTypePageCountsForAudit: vi.fn(),
  getJsonFromR2: vi.fn(),
  readStoredLighthousePayload: vi.fn(),
}));

vi.mock("@/server/features/audit/repositories/auditReportQueries", () => ({
  getLatestAuditAtOrBefore: mocks.getLatestAuditAtOrBefore,
  getMobileLighthouseForAudit: mocks.getMobileLighthouseForAudit,
}));
vi.mock("@/server/features/audit/repositories/auditSummaryQueries", () => ({
  getIssueTypePageCountsForAudit: mocks.getIssueTypePageCountsForAudit,
}));
vi.mock("@/server/lib/r2", () => ({ getJsonFromR2: mocks.getJsonFromR2 }));
vi.mock("@/server/lib/lighthousePayload", () => ({
  readStoredLighthousePayload: mocks.readStoredLighthousePayload,
}));

function ctx(query = "?asOf=2026-09-30") {
  return {
    project: { id: "proj-a", domain: "socialboothlv.com" },
    request: new Request(`https://seo.test/report/audit${query}`),
  };
}
function lighthouse(
  url: string,
  crawlDepth: number | null,
  performanceScore: number,
  r2Key: string | null = null,
) {
  return {
    url,
    crawlDepth,
    r2Key,
    performanceScore,
    accessibilityScore: 96,
    bestPracticesScore: 100,
    seoScore: 100,
    lcpMs: 2400,
    cls: 0.02,
    inpMs: null,
    ttfbMs: 410,
  };
}

describe("ReportAuditService.getAudit", () => {
  beforeEach(() => {
    mocks.getLatestAuditAtOrBefore.mockResolvedValue({
      id: "a_0930",
      status: "completed",
      startedAt: "2026-09-30 22:50:11",
      completedAt: "2026-09-30T22:50:19.953Z",
      pagesCrawled: 212,
    });
    mocks.getIssueTypePageCountsForAudit.mockResolvedValue([
      { issueType: "missing_alt", severity: "info", pages: 120 },
      { issueType: "missing_meta_description", severity: "warning", pages: 14 },
      { issueType: "thin_content", severity: "warning", pages: 27 },
      { issueType: "broken_link", severity: "critical", pages: 3 },
      ...Array.from({ length: 8 }, (_, i) => ({
        issueType: `info_${i}`,
        severity: "info",
        pages: i,
      })),
    ]);
    mocks.getMobileLighthouseForAudit.mockResolvedValue([
      lighthouse("https://socialboothlv.com/about", 1, 70),
      lighthouse(
        "https://socialboothlv.com/",
        0,
        78,
        "lighthouse/a_0930/home.json",
      ),
    ]);
    mocks.getJsonFromR2.mockResolvedValue("{}");
    mocks.readStoredLighthousePayload.mockReturnValue({
      storedPayload: { metrics: { totalBlockingTime: { numericValue: 180 } } },
    });
  });

  it("summarizes the as-of audit: severities, top 10 issues critical first, homepage mobile Lighthouse", async () => {
    const result = await ReportAuditService.getAudit(ctx());
    expect(mocks.getLatestAuditAtOrBefore).toHaveBeenCalledWith(
      "proj-a",
      "2026-09-30T23:59:59.999Z",
    );
    expect(result).toMatchObject({
      auditId: "a_0930",
      status: "completed",
      startedAt: "2026-09-30T22:50:11.000Z",
      completedAt: "2026-09-30T22:50:19.953Z",
      pagesCrawled: 212,
      issuesBySeverity: { critical: 3, warning: 41, info: 148 },
      lighthouse: {
        url: "https://socialboothlv.com/",
        strategy: "mobile",
        performance: 78,
        accessibility: 96,
        bestPractices: 100,
        seo: 100,
        lcpMs: 2400,
        cls: 0.02,
        inpMs: null,
        ttfbMs: 410,
        tbtMs: 180,
      },
    });
    expect(mocks.getJsonFromR2).toHaveBeenCalledWith(
      "lighthouse/a_0930/home.json",
    );
    expect(result.topIssues).toHaveLength(10);
    expect(result.topIssues.slice(0, 4)).toEqual([
      { issueType: "broken_link", severity: "critical", pages: 3 },
      { issueType: "thin_content", severity: "warning", pages: 27 },
      { issueType: "missing_meta_description", severity: "warning", pages: 14 },
      { issueType: "missing_alt", severity: "info", pages: 120 },
    ]);
  });

  it("picks the homepage deterministically when two homepage rows arrive in reverse url order", async () => {
    // Both https://www.socialboothlv.com/ and https://socialboothlv.com/ are
    // homepages. Sorted by [crawlDepth asc (nulls last), url asc], the
    // www-less form comes last alphabetically; the shorter url wins.
    mocks.getMobileLighthouseForAudit.mockResolvedValue([
      lighthouse("https://www.socialboothlv.com/", 0, 60),
      lighthouse("https://socialboothlv.com/", 0, 78),
    ]);
    const result = await ReportAuditService.getAudit(ctx());
    expect(result.lighthouse?.url).toBe("https://socialboothlv.com/");
  });

  it.each<[string, ReturnType<typeof lighthouse>[], string | null]>([
    [
      "no homepage → shallowest page",
      [
        lighthouse("https://socialboothlv.com/b", 2, 60),
        lighthouse("https://socialboothlv.com/a", 1, 65),
      ],
      "https://socialboothlv.com/a",
    ],
    ["no mobile results → null", [], null],
  ])("lighthouse fallback: %s", async (_label, rows, url) => {
    mocks.getMobileLighthouseForAudit.mockResolvedValue(rows);
    const result = await ReportAuditService.getAudit(ctx());
    expect(result.lighthouse?.url ?? null).toBe(url);
  });

  it.each<[string, () => void]>([
    [
      "the R2 object is missing",
      () =>
        mocks.getJsonFromR2.mockRejectedValue(
          new Error("Audit payload not found"),
        ),
    ],
    [
      "the payload is a legacy format",
      () =>
        mocks.readStoredLighthousePayload.mockReturnValue({
          storedPayload: null,
        }),
    ],
    [
      "the row has no r2Key",
      () =>
        mocks.getMobileLighthouseForAudit.mockResolvedValue([
          lighthouse("https://socialboothlv.com/", 0, 78),
        ]),
    ],
  ])("tbtMs is null (R7 still 200) when %s", async (_label, arrange) => {
    arrange();
    const result = await ReportAuditService.getAudit(ctx());
    expect(result.lighthouse).toMatchObject({
      url: "https://socialboothlv.com/",
      tbtMs: null,
    });
  });

  it("answers 409 when no audit started by asOf", async () => {
    mocks.getLatestAuditAtOrBefore.mockResolvedValue(null);
    await expect(ReportAuditService.getAudit(ctx())).rejects.toMatchObject({
      httpStatus: 409,
      code: "no_audit",
    });
  });

  it("answers 422 without asOf", async () => {
    await expect(ReportAuditService.getAudit(ctx(""))).rejects.toMatchObject({
      httpStatus: 422,
    });
  });
});
