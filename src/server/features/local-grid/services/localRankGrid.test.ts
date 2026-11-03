import { describe, expect, it, vi } from "vitest";
import { runRankGrid, summarizeGrid } from "./localRankGrid";

const base = {
  keyword: "brand activation photo booth las vegas",
  center: { latitude: 36.2108236, longitude: -115.2695665 },
  gridSize: 3,
  spacingKm: 2,
  device: "mobile" as const,
  languageCode: "en",
};

function clientReturning(items: Record<string, unknown>[]) {
  return { serp: { local: vi.fn().mockResolvedValue(items) } };
}

describe("runRankGrid", () => {
  it("matches by place_id, never by a look-alike title, and names the best competitor", async () => {
    const client = clientReturning([
      { rank_absolute: 1, title: "The Social Booth Co", cid: "111" },
      {
        rank_absolute: 2,
        title: "Social Booth LV",
        place_id: "ChIJuy0J",
        cid: "559",
      },
    ]);
    const { grid, matchedBusiness } = await runRankGrid({
      ...base,
      client,
      target: { placeId: "ChIJuy0J" },
    });

    expect(grid[0]).toMatchObject({
      rank: 2,
      topCompetitor: { title: "The Social Booth Co", cid: "111", rank: 1 },
    });
    expect(matchedBusiness).toEqual({
      title: "Social Booth LV",
      cid: "559",
      placeId: "ChIJuy0J",
    });
  });

  it("skips the target when it is first, so the competitor is the runner-up", async () => {
    const client = clientReturning([
      { rank_absolute: 1, title: "Social Booth LV", cid: "559" },
      { rank_absolute: 2, title: "BoothNV", cid: "447" },
    ]);
    const { grid } = await runRankGrid({
      ...base,
      client,
      target: { cid: "559" },
    });
    expect(grid[4]).toMatchObject({
      rank: 1,
      topCompetitor: { title: "BoothNV", rank: 2 },
    });
  });
});

const cell = (rank: number | null, error = false) => ({
  row: 0,
  col: 0,
  latitude: 0,
  longitude: 0,
  rank,
  ...(error ? { error: true } : {}),
});

describe("summarizeGrid", () => {
  it("SoLV and ATRP count not-found points as depth + 1 and leave failed points out", () => {
    // 1, 2, 5, not found (21), failed: SoLV 2/4, ARP (1+2+5)/3, ATRP (1+2+5+21)/4.
    const summary = summarizeGrid([
      cell(1),
      cell(2),
      cell(5),
      cell(null),
      cell(null, true),
    ]);
    expect(summary).toEqual({
      pointsSearched: 5,
      pointsFound: 3,
      averageRank: 2.67,
      top3Count: 2,
      top10Count: 3,
      solvPct: 50,
      atrp: 7.25,
    });
  });
});
