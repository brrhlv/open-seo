import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportGa4Service } from "./reportGa4Service";

const mocks = vi.hoisted(() => ({
  getByProjectId: vi.fn(),
  createGa4DataClient: vi.fn(),
  runReportRaw: vi.fn(),
}));

vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: { getByProjectId: mocks.getByProjectId },
}));
vi.mock("@/server/lib/ga4Client", () => ({
  createGa4DataClient: mocks.createGa4DataClient,
}));

const BODY = {
  dateRanges: [{ startDate: "2026-09-01", endDate: "2026-09-30" }],
  dimensions: [{ name: "sessionDefaultChannelGroup" }],
  metrics: [{ name: "sessions" }],
  metricAggregations: ["TOTAL"],
  limit: 10,
};
const RAW = { rows: [], totals: [{ metricValues: [{ value: "42" }] }] };

function ctx(body: unknown) {
  return {
    project: { id: "proj-a", domain: "socialboothlv.com" },
    request: new Request("https://seo.test/report", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  };
}

describe("ReportGa4Service.runGa4Report", () => {
  beforeEach(() => {
    mocks.getByProjectId.mockResolvedValue({
      propertyId: "properties/123",
      propertyTimeZone: "America/Los_Angeles",
      connectedByUserId: "user_1",
      ga4AccountId: "acct_1",
    });
    mocks.createGa4DataClient.mockReturnValue({
      runReportRaw: mocks.runReportRaw,
    });
    mocks.runReportRaw.mockResolvedValue(RAW);
  });

  it("runs the body verbatim against the project's own property and returns the raw response", async () => {
    await expect(ReportGa4Service.runGa4Report(ctx(BODY))).resolves.toEqual({
      propertyId: "properties/123",
      timeZone: "America/Los_Angeles",
      response: RAW,
    });
    expect(mocks.getByProjectId).toHaveBeenCalledWith("proj-a");
    expect(mocks.createGa4DataClient).toHaveBeenCalledWith({
      userId: "user_1",
      ga4AccountId: "acct_1",
      propertyId: "properties/123",
    });
    expect(mocks.runReportRaw).toHaveBeenCalledWith(BODY);
  });

  it("answers 409 when GA4 is not connected", async () => {
    mocks.getByProjectId.mockResolvedValue(null);
    await expect(
      ReportGa4Service.runGa4Report(ctx(BODY)),
    ).rejects.toMatchObject({
      httpStatus: 409,
      code: "ga4_not_connected",
    });
  });

  it.each([
    ["a property override", { ...BODY, property: "properties/999" }],
    ["limit over 10000", { ...BODY, limit: 10_001 }],
    [
      "more than 10 metrics",
      {
        ...BODY,
        metrics: Array.from({ length: 11 }, (_, i) => ({ name: `m${i}` })),
      },
    ],
  ])("answers 422 for %s without calling Google", async (_label, body) => {
    await expect(
      ReportGa4Service.runGa4Report(ctx(body)),
    ).rejects.toMatchObject({
      httpStatus: 422,
      code: "invalid_request",
    });
    expect(mocks.runReportRaw).not.toHaveBeenCalled();
  });
});
