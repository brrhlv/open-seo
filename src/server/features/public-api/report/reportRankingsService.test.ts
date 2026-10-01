import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportRankingsService } from "./reportRankingsService";

const mocks = vi.hoisted(() => ({
  getConfigsForProject: vi.fn(),
  getSnapshotsForRun: vi.fn(),
  getKeywordsForConfig: vi.fn(),
  getLatestCompletedFullRunAtOrBefore: vi.fn(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getConfigsForProject: mocks.getConfigsForProject,
      getSnapshotsForRun: mocks.getSnapshotsForRun,
      getKeywordsForConfig: mocks.getKeywordsForConfig,
    },
  }),
);
vi.mock("@/server/features/rank-tracking/repositories/snapshotQueries", () => ({
  getLatestCompletedFullRunAtOrBefore:
    mocks.getLatestCompletedFullRunAtOrBefore,
}));

const CONFIG = {
  id: "cfg_1",
  domain: "socialboothlv.com",
  locationCode: 1022620,
  locationName: "Las Vegas,Nevada,United States",
  devices: "mobile",
  serpDepth: 100,
};

function ctx(query: string) {
  return {
    project: { id: "proj-a", domain: "socialboothlv.com" },
    request: new Request(`https://seo.test/report/rankings${query}`),
  };
}
function snap(
  trackingKeywordId: string,
  keyword: string,
  position: number | null,
  url: string | null,
) {
  return { trackingKeywordId, keyword, device: "mobile", position, url };
}

describe("ReportRankingsService.getRankings", () => {
  beforeEach(() => {
    mocks.getConfigsForProject.mockResolvedValue([CONFIG]);
    mocks.getLatestCompletedFullRunAtOrBefore.mockImplementation(
      (_configId: string, cutoff: string) =>
        Promise.resolve(
          cutoff.startsWith("2026-09-30")
            ? { id: "run_sep", completedAt: "2026-09-29T03:17:00.000Z" }
            : { id: "run_aug", completedAt: "2026-08-25 03:17:00" },
        ),
    );
    mocks.getSnapshotsForRun.mockImplementation((runId: string) =>
      Promise.resolve(
        runId === "run_sep"
          ? [
              snap(
                "kw_1",
                "photo booth rental las vegas",
                4,
                "https://socialboothlv.com/",
              ),
              snap("kw_2", "360 photo booth", null, null),
              snap("kw_3", "new keyword", 12, "https://socialboothlv.com/360/"),
            ]
          : [
              snap(
                "kw_1",
                "photo booth rental las vegas",
                6,
                "https://socialboothlv.com/old/",
              ),
              // Checked in August, not found within serpDepth.
              snap("kw_2", "360 photo booth", null, null),
            ],
      ),
    );
    mocks.getKeywordsForConfig.mockResolvedValue([
      { id: "kw_1", searchVolume: 1300 },
      { id: "kw_2", searchVolume: 210 },
      { id: "kw_3", searchVolume: null },
    ]);
  });

  it("pairs the as-of and compare runs per keyword x device, by volume", async () => {
    await expect(
      ReportRankingsService.getRankings(
        ctx("?asOf=2026-09-30&compareTo=2026-08-31"),
      ),
    ).resolves.toEqual({
      configs: [
        {
          ...CONFIG,
          asOfRunAt: "2026-09-29T03:17:00.000Z",
          compareToRunAt: "2026-08-25T03:17:00.000Z",
        },
      ],
      asOfRunAt: "2026-09-29T03:17:00.000Z",
      compareToRunAt: "2026-08-25T03:17:00.000Z",
      keywords: [
        {
          configId: "cfg_1",
          keyword: "photo booth rental las vegas",
          device: "mobile",
          searchVolume: 1300,
          position: 4,
          url: "https://socialboothlv.com/",
          previousPosition: 6,
          previousUrl: "https://socialboothlv.com/old/",
          previousChecked: true,
        },
        // Checked and not found in the compare run vs never checked then:
        {
          configId: "cfg_1",
          keyword: "360 photo booth",
          device: "mobile",
          searchVolume: 210,
          position: null,
          url: null,
          previousPosition: null,
          previousUrl: null,
          previousChecked: true,
        },
        {
          configId: "cfg_1",
          keyword: "new keyword",
          device: "mobile",
          searchVolume: null,
          position: 12,
          url: "https://socialboothlv.com/360/",
          previousPosition: null,
          previousUrl: null,
          previousChecked: false,
        },
      ],
    });
    expect(mocks.getLatestCompletedFullRunAtOrBefore).toHaveBeenCalledWith(
      "cfg_1",
      "2026-09-30T23:59:59.999Z",
    );
    expect(mocks.getLatestCompletedFullRunAtOrBefore).toHaveBeenCalledWith(
      "cfg_1",
      "2026-08-31T23:59:59.999Z",
    );
  });

  it("marks every row previousChecked:false when no compareTo is given", async () => {
    const result = await ReportRankingsService.getRankings(
      ctx("?asOf=2026-09-30"),
    );
    expect(result.compareToRunAt).toBeNull();
    expect(result.keywords.map((row) => row.previousChecked)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("returns 200 with no keywords when nothing completed by asOf", async () => {
    mocks.getLatestCompletedFullRunAtOrBefore.mockResolvedValue(null);
    await expect(
      ReportRankingsService.getRankings(ctx("?asOf=2026-09-30")),
    ).resolves.toMatchObject({
      asOfRunAt: null,
      compareToRunAt: null,
      keywords: [],
    });
    expect(mocks.getSnapshotsForRun).not.toHaveBeenCalled();
  });

  it("answers 409 when the project has no active tracker", async () => {
    mocks.getConfigsForProject.mockResolvedValue([]);
    await expect(
      ReportRankingsService.getRankings(ctx("?asOf=2026-09-30")),
    ).rejects.toMatchObject({
      httpStatus: 409,
      code: "no_rank_tracker",
    });
  });

  it.each(["", "?asOf=2026-09-31", "?asOf=2026-09-30&compareTo=2026-10-01"])(
    "answers 422 for %j",
    async (query) => {
      await expect(
        ReportRankingsService.getRankings(ctx(query)),
      ).rejects.toMatchObject({ httpStatus: 422 });
    },
  );
});
