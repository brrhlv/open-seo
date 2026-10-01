import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import { ReportBacklinksService } from "./reportBacklinksService";
import { ReportApiError } from "./reportErrors";

const mocks = vi.hoisted(() => ({
  dataforseoPost: vi.fn(),
  getLatestForProject: vi.fn(),
  insert: vi.fn(),
  updateById: vi.fn(),
  normalizeBacklinksTarget: vi.fn(),
}));

vi.mock("@/server/lib/dataforseo/core", () => ({
  dataforseoPost: mocks.dataforseoPost,
}));
vi.mock("@/server/lib/dataforseoBacklinksTarget", () => ({
  normalizeBacklinksTarget: mocks.normalizeBacklinksTarget,
}));
vi.mock(
  "@/server/features/dashboard/repositories/BacklinkSnapshotRepository",
  () => ({
    BacklinkSnapshotRepository: {
      getLatestForProject: mocks.getLatestForProject,
      insert: mocks.insert,
      updateById: mocks.updateById,
    },
  }),
);

const NOW = new Date("2026-10-01T12:00:00.000Z");
const SUMMARY_TASK = {
  status_code: 20000,
  status_message: "Ok.",
  path: ["v3", "backlinks", "summary", "live"],
  cost: 0.02003,
  result: [
    {
      target: "socialboothlv.com",
      rank: 312,
      backlinks: 900,
      referring_domains: 120,
      broken_backlinks: 3,
      new_reffering_domains: 4,
      lost_reffering_domains: 2,
    },
  ],
};

function ctx(body: unknown) {
  return {
    project: { id: "proj-a", domain: "socialboothlv.com" },
    request: new Request("https://seo.test/report", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  };
}
const run = (body: unknown, kind = "summary") =>
  ReportBacklinksService.runBacklinksReport(ctx(body), kind, NOW);

describe("ReportBacklinksService.runBacklinksReport", () => {
  beforeEach(() => {
    mocks.dataforseoPost.mockResolvedValue({
      status_code: 20000,
      tasks: [SUMMARY_TASK],
    });
    mocks.getLatestForProject.mockResolvedValue(null);
    mocks.insert.mockResolvedValue({});
    mocks.updateById.mockResolvedValue(undefined);
    mocks.normalizeBacklinksTarget.mockReturnValue({
      apiTarget: "socialboothlv.com",
    });
  });

  it("answers 409 no_domain when the stored domain is not a valid backlinks target", async () => {
    mocks.normalizeBacklinksTarget.mockImplementation(() => {
      throw new AppError("VALIDATION_ERROR", "Enter a valid domain");
    });
    await expect(run({})).rejects.toMatchObject({
      httpStatus: 409,
      code: "no_domain",
    });
    expect(mocks.dataforseoPost).not.toHaveBeenCalled();
  });

  it("forces the project domain as target, returns the raw task + cost, and records a 0-100 rank snapshot", async () => {
    await expect(
      run({ include_subdomains: true, internal_list_limit: 10 }),
    ).resolves.toEqual({
      target: "socialboothlv.com",
      costUsd: 0.02003,
      response: SUMMARY_TASK,
    });
    expect(mocks.dataforseoPost).toHaveBeenCalledWith(
      "/v3/backlinks/summary/live",
      [
        {
          include_subdomains: true,
          internal_list_limit: 10,
          target: "socialboothlv.com",
        },
      ],
    );
    expect(mocks.insert).toHaveBeenCalledWith({
      projectId: "proj-a",
      domain: "socialboothlv.com",
      rank: 31,
      backlinks: 900,
      referringDomains: 120,
      brokenBacklinks: 3,
      newBacklinks: null,
      lostBacklinks: null,
      newReferringDomains: 4,
      lostReferringDomains: 2,
      capturedAt: "2026-10-01T12:00:00.000Z",
    });
  });

  it("updates today's snapshot instead of adding a second row", async () => {
    mocks.getLatestForProject.mockResolvedValue({
      id: 7,
      domain: "socialboothlv.com",
      capturedAt: "2026-10-01T03:00:00.000Z",
    });
    await run({});
    expect(mocks.updateById).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ backlinks: 900, rank: 31 }),
    );
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("adds a new row when the latest snapshot is from an earlier day", async () => {
    mocks.getLatestForProject.mockResolvedValue({
      id: 7,
      domain: "socialboothlv.com",
      capturedAt: "2026-09-30 23:00:00",
    });
    await run({});
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.updateById).not.toHaveBeenCalled();
  });

  it("passes a failed task through untouched and writes no snapshot", async () => {
    const failed = {
      status_code: 40501,
      status_message: "Invalid Field",
      cost: 0,
      result: null,
    };
    mocks.dataforseoPost.mockResolvedValue({
      status_code: 20000,
      tasks: [failed],
    });
    await expect(run({})).resolves.toEqual({
      target: "socialboothlv.com",
      costUsd: 0,
      response: failed,
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("never writes a snapshot for history or backlinks calls", async () => {
    await run({ date_from: "2026-04-01", date_to: "2026-09-30" }, "history");
    await run({ mode: "one_per_domain", limit: 25 }, "backlinks");
    expect(mocks.dataforseoPost).toHaveBeenCalledWith(
      "/v3/backlinks/history/live",
      [
        {
          date_from: "2026-04-01",
          date_to: "2026-09-30",
          target: "socialboothlv.com",
        },
      ],
    );
    expect(mocks.getLatestForProject).not.toHaveBeenCalled();
  });

  it.each<[string, string, unknown]>([
    ["a caller target", "summary", { target: "evil.com" }],
    ["limit 101", "backlinks", { limit: 101 }],
    ["a bad date", "history", { date_from: "2026-13-01" }],
  ])(
    "answers 422 for %s without calling DataForSEO",
    async (_label, kind, body) => {
      await expect(run(body, kind)).rejects.toMatchObject({ httpStatus: 422 });
      expect(mocks.dataforseoPost).not.toHaveBeenCalled();
    },
  );

  it("answers 404 for an unknown kind", async () => {
    await expect(run({}, "referring_domains")).rejects.toMatchObject({
      httpStatus: 404,
      code: "not_found",
    });
  });

  it("skips the snapshot for a non-dashboard-equivalent summary (backlinks_status_type lost)", async () => {
    await expect(run({ backlinks_status_type: "lost" })).resolves.toMatchObject(
      {
        target: "socialboothlv.com",
      },
    );
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.updateById).not.toHaveBeenCalled();
  });

  it("still returns 200 with the raw task when the snapshot insert throws", async () => {
    mocks.insert.mockRejectedValue(new Error("D1 busy"));
    await expect(run({})).resolves.toMatchObject({
      target: "socialboothlv.com",
      response: SUMMARY_TASK,
    });
  });

  it.each<[string, () => void, number, Record<string, unknown>]>([
    [
      "an HTTP 429",
      () =>
        mocks.dataforseoPost.mockRejectedValue(
          new AppError("RATE_LIMITED", "x", { providerStatus: "429" }),
        ),
      429,
      { error: "upstream_quota" },
    ],
    [
      "an HTTP 503",
      () =>
        mocks.dataforseoPost.mockRejectedValue(
          new AppError("UPSTREAM_UNAVAILABLE", "x", { providerStatus: "503" }),
        ),
      502,
      { error: "upstream_error", status: 503 },
    ],
    [
      "a top-level 40100",
      () =>
        mocks.dataforseoPost.mockResolvedValue({
          status_code: 40100,
          tasks: [],
        }),
      502,
      { error: "upstream_error", status: 40100 },
    ],
  ])("maps %s", async (_label, arrange, status, body) => {
    arrange();
    const error: unknown = await run({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReportApiError);
    if (error instanceof ReportApiError) {
      expect([error.httpStatus, error.toBody()]).toEqual([status, body]);
    }
  });
});
