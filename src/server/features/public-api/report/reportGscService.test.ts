import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportGscService } from "./reportGscService";

const mocks = vi.hoisted(() => ({
  getByProjectId: vi.fn(),
  createGscClient: vi.fn(),
  querySearchAnalytics: vi.fn(),
  listSitemaps: vi.fn(),
  inspectUrl: vi.fn(),
}));

vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: { getByProjectId: mocks.getByProjectId },
}));
vi.mock("@/server/lib/gscClient", () => ({
  createGscClient: mocks.createGscClient,
}));

const SITE = "sc-domain:socialboothlv.com";
const ROWS = [
  { keys: ["photo booth"], clicks: 1, impressions: 2, ctr: 0.5, position: 3 },
];

function ctx(body?: unknown) {
  return {
    project: { id: "proj-a", domain: "socialboothlv.com" },
    request: new Request(
      "https://seo.test/report",
      body === undefined
        ? undefined
        : { method: "POST", body: JSON.stringify(body) },
    ),
  };
}

describe("ReportGscService", () => {
  beforeEach(() => {
    mocks.getByProjectId.mockResolvedValue({
      siteUrl: SITE,
      connectedByUserId: "user_1",
      gscAccountId: "sub_1",
    });
    mocks.createGscClient.mockReturnValue({
      querySearchAnalytics: mocks.querySearchAnalytics,
      listSitemaps: mocks.listSitemaps,
      inspectUrl: mocks.inspectUrl,
    });
    mocks.querySearchAnalytics.mockResolvedValue(ROWS);
    mocks.listSitemaps.mockResolvedValue({
      sitemap: [{ path: "https://socialboothlv.com/sitemap.xml" }],
    });
    mocks.inspectUrl.mockResolvedValue({
      indexStatusResult: { verdict: "PASS" },
    });
  });

  it("R2 sends the body verbatim (no dataState default) and wraps rows", async () => {
    const body = {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      dimensions: ["query"],
      rowLimit: 1000,
    };
    await expect(
      ReportGscService.querySearchAnalytics(ctx(body)),
    ).resolves.toEqual({
      siteUrl: SITE,
      response: { rows: ROWS },
    });
    expect(mocks.createGscClient).toHaveBeenCalledWith({
      userId: "user_1",
      gscAccountId: "sub_1",
    });
    expect(mocks.querySearchAnalytics).toHaveBeenCalledWith(SITE, body);
  });

  it("R2 rejects a rowLimit over 25000 without calling Google", async () => {
    await expect(
      ReportGscService.querySearchAnalytics(
        ctx({
          startDate: "2026-09-01",
          endDate: "2026-09-30",
          rowLimit: 25_001,
        }),
      ),
    ).rejects.toMatchObject({ httpStatus: 422 });
    expect(mocks.querySearchAnalytics).not.toHaveBeenCalled();
  });

  it("maps a transport failure (fetch rejection) to 502 upstream_error status 0", async () => {
    mocks.querySearchAnalytics.mockRejectedValue(new TypeError("fetch failed"));
    const error: unknown = await ReportGscService.querySearchAnalytics(
      ctx({ startDate: "2026-09-01", endDate: "2026-09-30" }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      httpStatus: 502,
      code: "upstream_error",
      extra: { status: 0 },
    });
  });

  it("R3 returns the raw sitemaps list", async () => {
    await expect(ReportGscService.listSitemaps(ctx())).resolves.toEqual({
      siteUrl: SITE,
      response: {
        sitemap: [{ path: "https://socialboothlv.com/sitemap.xml" }],
      },
    });
  });

  it("answers 409 when Search Console is not connected", async () => {
    mocks.getByProjectId.mockResolvedValue(null);
    await expect(ReportGscService.listSitemaps(ctx())).rejects.toMatchObject({
      httpStatus: 409,
      code: "gsc_not_connected",
    });
  });

  it("R4 inspects a URL on a subdomain of the project domain", async () => {
    const url = "https://www.socialboothlv.com/photo-booth";
    await expect(
      ReportGscService.inspectUrl(ctx({ inspectionUrl: url })),
    ).resolves.toEqual({
      siteUrl: SITE,
      response: {
        inspectionResult: { indexStatusResult: { verdict: "PASS" } },
      },
    });
    expect(mocks.inspectUrl).toHaveBeenCalledWith(SITE, url);
  });

  it.each([
    "https://evil.example/",
    "https://socialboothlv.com.evil.io/",
    "javascript:alert(1)",
  ])("R4 answers 422 for %s without calling Google", async (inspectionUrl) => {
    await expect(
      ReportGscService.inspectUrl(ctx({ inspectionUrl })),
    ).rejects.toMatchObject({
      httpStatus: 422,
      code: "invalid_request",
    });
    expect(mocks.inspectUrl).not.toHaveBeenCalled();
  });

  it("R2 rejects a smuggled siteUrl", async () => {
    await expect(
      ReportGscService.querySearchAnalytics(
        ctx({
          startDate: "2026-09-01",
          endDate: "2026-09-30",
          siteUrl: "sc-domain:evil.com",
        }),
      ),
    ).rejects.toMatchObject({ httpStatus: 422 });
    expect(mocks.querySearchAnalytics).not.toHaveBeenCalled();
  });
});
