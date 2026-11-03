import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSavedKeywordsSection } from "./savedKeywords";

const mocks = vi.hoisted(() => ({ listSavedKeywordsByProject: vi.fn() }));

vi.mock(
  "@/server/features/keywords/repositories/KeywordResearchRepository",
  () => ({
    KeywordResearchRepository: {
      listSavedKeywordsByProject: mocks.listSavedKeywordsByProject,
    },
  }),
);

function tag(name: string) {
  return { id: `t-${name}`, name, normalizedName: name, color: null };
}

function listRow(
  keyword: string,
  metric: Record<string, unknown> | null,
  tags: string[],
) {
  return {
    row: {
      id: `k-${keyword}`,
      projectId: "proj-a",
      keyword,
      locationCode: 2840,
      languageCode: "en",
      createdAt: "2026-11-03 18:00:00",
    },
    metric,
    tags: tags.map(tag),
  };
}

describe("getSavedKeywordsSection", () => {
  beforeEach(() => {
    mocks.listSavedKeywordsByProject.mockResolvedValue({
      rows: [],
      totalCount: 0,
      tags: [],
    });
  });

  it("returns an empty section for a project with no saved keywords", async () => {
    expect(await getSavedKeywordsSection("proj-a")).toEqual({
      totalCount: 0,
      truncated: false,
      tags: [],
      keywords: [],
    });
  });

  it("maps rows, tags and timestamps to the wire contract", async () => {
    mocks.listSavedKeywordsByProject.mockResolvedValue({
      totalCount: 2,
      tags: [{ ...tag("blog-idea"), keywordCount: 2 }],
      rows: [
        listRow(
          "casino night event",
          {
            searchVolume: 1000,
            keywordDifficulty: 0,
            cpc: 1.25,
            intent: "informational",
            fetchedAt: "2026-11-03T07:27:39.000Z",
          },
          ["blog-idea", "cluster:corporate-events"],
        ),
        listRow("gala ideas", null, ["blog-idea"]),
      ],
    });

    const section = await getSavedKeywordsSection("proj-a");

    expect(section.tags).toEqual([{ name: "blog-idea", keywordCount: 2 }]);
    expect(section.keywords).toEqual([
      {
        keyword: "casino night event",
        searchVolume: 1000,
        keywordDifficulty: 0,
        cpc: 1.25,
        intent: "informational",
        tags: ["blog-idea", "cluster:corporate-events"],
        savedAt: "2026-11-03T18:00:00.000Z",
        metricsFetchedAt: "2026-11-03T07:27:39.000Z",
        locationCode: 2840,
        languageCode: "en",
      },
      {
        keyword: "gala ideas",
        searchVolume: null,
        keywordDifficulty: null,
        cpc: null,
        intent: null,
        tags: ["blog-idea"],
        savedAt: "2026-11-03T18:00:00.000Z",
        metricsFetchedAt: null,
        locationCode: 2840,
        languageCode: "en",
      },
    ]);
  });

  it("reads the newest 100 and flags a longer list as truncated", async () => {
    mocks.listSavedKeywordsByProject.mockResolvedValue({
      totalCount: 150,
      tags: [],
      rows: [listRow("a", null, [])],
    });

    const section = await getSavedKeywordsSection("proj-a");

    expect(section).toMatchObject({ totalCount: 150, truncated: true });
    expect(mocks.listSavedKeywordsByProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-a",
        page: 1,
        pageSize: 100,
        sort: "createdAt",
        order: "desc",
      }),
    );
  });
});
