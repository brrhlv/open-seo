import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as LocalGridServiceModule from "@/server/features/local-grid/services/LocalGridService";
import {
  createLocalGridTrackerTool,
  getLocalGridTool,
  runLocalGridTool,
} from "./local-grid-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  createTracker: vi.fn(),
  runCheck: vi.fn(),
  getLatest: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock(
  "@/server/features/local-grid/services/LocalGridService",
  async (importOriginal) => {
    const actual = await importOriginal<typeof LocalGridServiceModule>();
    return {
      ...actual,
      LocalGridService: {
        createTracker: mocks.createTracker,
        runCheck: mocks.runCheck,
        getLatest: mocks.getLatest,
      },
    };
  },
);

const projectId = "11111111-1111-4111-8111-111111111111";
const toolContext = makeToolContext();
const config = {
  id: "cfg-1",
  projectId,
  targetName: "Social Booth LV",
  targetPlaceId: "ChIJuy0J",
  targetCid: "559",
  centerLatitude: 36.2108236,
  centerLongitude: -115.2695665,
  gridSize: 3,
  spacingKm: 2,
  device: "mobile" as const,
  languageCode: "en",
  scheduleInterval: "monthly" as const,
  isActive: true,
  lastCheckedAt: "2026-11-02T07:00:00.000Z",
  nextCheckAt: "2026-12-02T07:00:00.000Z",
  lastError: null,
  createdAt: "2026-11-01 12:00:00",
};

const snapshot = (period: string, rank: number) => ({
  id: rank,
  projectId,
  keyword: "brand activation photo booth las vegas",
  period,
  centerLatitude: 36.2108236,
  centerLongitude: -115.2695665,
  gridSize: 3,
  spacingKm: 2,
  zoom: 13,
  device: "mobile" as const,
  pointsSearched: 9,
  pointsFound: 9,
  top3Count: 9,
  top10Count: 9,
  solvPct: 100,
  arp: rank,
  atrp: rank,
  matchedTitle: "Social Booth LV",
  matchedPlaceId: "ChIJuy0J",
  matchedCid: "559",
  billingCostUsd: 0.018,
  capturedAt: `${period}-02T07:00:00.000Z`,
  cells: Array.from({ length: 9 }, (_, i) => ({
    row: Math.floor(i / 3),
    col: i % 3,
    latitude: 0,
    longitude: 0,
    rank,
    resultsCount: 6,
    topCompetitor: null,
    error: false,
  })),
});

beforeEach(() => {
  mocks.getProjectForOrganization.mockResolvedValue({
    id: projectId,
    domain: "socialboothlv.com",
    locationCode: 2840,
    languageCode: "en",
  });
});

describe("local grid MCP tools", () => {
  it("create_local_grid_tracker states the monthly estimate and spends nothing", async () => {
    mocks.createTracker.mockResolvedValue({
      config,
      keywords: ["a", "b", "c"],
    });
    const result = await createLocalGridTrackerTool.handler(
      {
        projectId,
        keywords: ["a", "b", "c"],
        target: { placeId: "ChIJuy0J" },
        center: { latitude: 36.2108236, longitude: -115.2695665 },
      },
      toolContext,
    );
    expect(result.structuredContent.estimatedMonthlyCostUsd).toBe(0.054);
    expect(textContent(result)).toContain("no credits were used");
  });

  it("run_local_grid reports cost, already-captured and remaining keywords", async () => {
    mocks.runCheck.mockResolvedValue({
      period: "2026-11",
      checked: [
        {
          keyword: "a",
          costUsd: 0.018,
          pointsFound: 9,
          pointsSearched: 9,
          solvPct: 100,
          arp: 1.56,
          atrp: 1.56,
        },
      ],
      alreadyCaptured: ["b"],
      remaining: ["c"],
      costUsd: 0.018,
    });
    const text = textContent(
      await runLocalGridTool.handler({ projectId }, toolContext),
    );
    expect(text).toContain("DataForSEO cost: $0.0180");
    expect(text).toContain("Already gridded for 2026-11 (no credits used): b");
    expect(text).toContain("Not run yet (over 3 per call): c");
  });

  it("get_local_grid renders the grid north-first with the monthly change", async () => {
    mocks.getLatest.mockResolvedValue({
      config,
      trackerKeywords: ["brand activation photo booth las vegas"],
      keywords: [
        {
          keyword: "brand activation photo booth las vegas",
          latest: snapshot("2026-11", 1),
          previous: snapshot("2026-10", 3),
        },
      ],
    });
    const result = await getLocalGridTool.handler({ projectId }, toolContext);
    const text = textContent(result);
    expect(text).toContain(
      "SoLV 100%, ARP 1, ATRP 1 (vs 2026-10: SoLV 0 pts, ARP -2, ATRP -2)",
    );
    expect(text).toContain(" 1  1  1");
    expect(result.structuredContent.keywords[0]).toMatchObject({
      delta: { arp: -2, solvPct: 0, pointsFound: 0 },
      previous: { period: "2026-10" },
    });
  });
});
