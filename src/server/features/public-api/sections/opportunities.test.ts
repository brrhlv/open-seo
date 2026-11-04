import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ga4ReportError } from "@/server/lib/ga4Errors";
import { GscNotConnectedError } from "@/server/lib/gscErrors";
import { getOpportunitiesSection } from "./opportunities";

const mocks = vi.hoisted(() => ({
  getOpportunities: vi.fn(),
  getCached: vi.fn(),
  setCached: vi.fn(),
}));
vi.mock("@/server/features/ga4/services/SearchOpportunityService", () => ({
  SearchOpportunityService: { getOpportunities: mocks.getOpportunities },
}));
vi.mock("@/server/lib/r2-cache", () => ({
  getCached: mocks.getCached,
  setCached: mocks.setCached,
}));

const NOW = new Date("2026-11-02T18:00:00.000Z");

function row(overrides: Record<string, unknown>) {
  return {
    page: "https://a.com/x",
    clicks: 1,
    impressions: 50,
    ctr: 0.02,
    position: 12,
    ga4: null,
    score: null,
    scoreComponents: null,
    ...overrides,
  };
}

const result = {
  request: { dateRange: { startDate: "2026-10-03", endDate: "2026-10-30" } },
  scoring: { businessValueMetric: "sessionKeyEventRate" },
  totalCandidateRows: 2,
  rows: [
    row({
      page: "https://a.com/corporate-events",
      clicks: 9,
      impressions: 1840,
      ctr: 0.0049,
      position: 7.4,
      ga4: { sessions: 21, keyEvents: 2 },
      score: 82,
      scoreComponents: { demand: 0.9, businessValue: 0.4, reachability: 0.7 },
    }),
    row({ page: "https://a.com/blog/x" }),
  ],
};

describe("getOpportunitiesSection", () => {
  beforeEach(() => {
    mocks.getCached.mockResolvedValue(null);
    mocks.setCached.mockResolvedValue(undefined);
    mocks.getOpportunities.mockResolvedValue(result);
  });

  it("shapes scored rows with reason codes and caches the section", async () => {
    const section = await getOpportunitiesSection("p", NOW);
    expect(mocks.getOpportunities).toHaveBeenCalledWith(
      { projectId: "p", limit: 35 },
      { now: NOW },
    );
    expect(section).toEqual({
      connected: true,
      capturedAt: NOW.toISOString(),
      dateRange: { startDate: "2026-10-03", endDate: "2026-10-30" },
      businessValueMetric: "sessionKeyEventRate",
      totalCandidates: 2,
      rows: [
        {
          page: "https://a.com/corporate-events",
          score: 82,
          why: ["high_demand", "near_page_one", "low_ctr"],
          clicks: 9,
          impressions: 1840,
          ctr: 0.0049,
          position: 7.4,
          sessions: 21,
          keyEvents: 2,
        },
        expect.objectContaining({
          page: "https://a.com/blog/x",
          score: null,
          why: ["no_analytics"],
          sessions: null,
        }),
      ],
    });
    expect(mocks.setCached).toHaveBeenCalledWith(
      "public-summary:opportunities:v3:p",
      section,
      6 * 60 * 60,
    );
  });

  it("leaves admin, API and auth routes out of the rows", async () => {
    mocks.getOpportunities.mockResolvedValue({
      ...result,
      totalCandidateRows: 4,
      rows: [
        row({ page: "https://a.com/admin/login", score: 90 }),
        ...result.rows,
        row({ page: "https://a.com/api/leads" }),
      ],
    });
    const section = await getOpportunitiesSection("p", NOW);
    if (!("rows" in section)) throw new Error("expected rows");
    expect(section.rows.map((r) => r.page)).toEqual([
      "https://a.com/corporate-events",
      "https://a.com/blog/x",
    ]);
    expect(section.totalCandidates).toBe(2);
  });

  it("serves a valid cached section without calling Google", async () => {
    const cached = { ...(await getOpportunitiesSection("p", NOW)) };
    mocks.getOpportunities.mockClear();
    mocks.getCached.mockResolvedValue(cached);
    expect(await getOpportunitiesSection("p", NOW)).toEqual(cached);
    expect(mocks.getOpportunities).not.toHaveBeenCalled();
  });

  it("is connected:false when GSC or GA4 is not linked, remembered for 10 minutes", async () => {
    mocks.getOpportunities.mockRejectedValueOnce(new GscNotConnectedError("p"));
    expect(await getOpportunitiesSection("p", NOW)).toEqual({
      connected: false,
    });
    mocks.getOpportunities.mockRejectedValueOnce(
      new Ga4ReportError("ga4_not_connected", "no"),
    );
    expect(await getOpportunitiesSection("p", NOW)).toEqual({
      connected: false,
    });
    expect(mocks.setCached).toHaveBeenCalledWith(
      "public-summary:opportunities:v3:p",
      { connected: false },
      600,
    );
  });

  it("turns other failures into a section error, remembered for 10 minutes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getOpportunities.mockRejectedValue(
      new Ga4ReportError("ga4_quota_exhausted", "quota"),
    );
    expect(await getOpportunitiesSection("p", NOW)).toEqual({
      error: "ga4_quota_exhausted",
    });
    expect(mocks.setCached).toHaveBeenCalledWith(
      "public-summary:opportunities:v3:p",
      { error: "ga4_quota_exhausted" },
      600,
    );
    mocks.getOpportunities.mockClear();
    mocks.getCached.mockResolvedValue({ error: "ga4_quota_exhausted" });
    expect(await getOpportunitiesSection("p", NOW)).toEqual({
      error: "ga4_quota_exhausted",
    });
    expect(mocks.getOpportunities).not.toHaveBeenCalled();
  });
});
