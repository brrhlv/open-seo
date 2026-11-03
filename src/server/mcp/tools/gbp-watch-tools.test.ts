import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as GbpWatchServiceModule from "@/server/features/gbp-watch/services/GbpWatchService";
import {
  getGbpWatchTool,
  runGbpSnapshotTool,
  setGbpWatchTool,
} from "./gbp-watch-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getWatch: vi.fn(),
  runSnapshot: vi.fn(),
  setWatch: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock(
  "@/server/features/gbp-watch/services/GbpWatchService",
  async (importOriginal) => ({
    ...(await importOriginal<typeof GbpWatchServiceModule>()),
    GbpWatchService: {
      getWatch: mocks.getWatch,
      runSnapshot: mocks.runSnapshot,
      setWatch: mocks.setWatch,
    },
  }),
);

const projectId = "11111111-1111-4111-8111-111111111111";
const toolContext = makeToolContext();

describe("GBP watch MCP tools", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: projectId,
      domain: "socialboothlv.com",
      locationCode: 2840,
      languageCode: "en",
    });
  });

  it("get_gbp_watch reads stored drift and spends nothing", async () => {
    mocks.getWatch.mockResolvedValue({
      tracked: true,
      placeId: null,
      cid: "5590594803775798319",
      listingId: null,
      lastCheckedAt: "2026-11-09T14:00:00.000Z",
      nextCheckAt: "2026-11-16T14:00:00.000Z",
      lastError: null,
      profile: {
        capturedAt: "2026-11-09T14:00:00.000Z",
        title: "Social Booth LV",
        primaryCategory: "Photo booth",
        additionalCategories: ["Party equipment rental service"],
        website: "https://socialboothlv.com/",
        hoursText: "Every day 09:00–21:00",
      },
      rating: { value: 5, reviewCount: 113, valueChange: null },
      latestReviews: [],
      newReviewCount: 0,
      questionsAvailable: false,
      unansweredQuestions: [],
      ownerUpdates: null,
      changes: [],
      driftFromExpected: [
        {
          field: "additionalCategories",
          rule: "forbidden_category",
          expected: "Not listed",
          actual: "Party equipment rental service",
          since: "2026-11-09T14:00:00.000Z",
        },
      ],
      expected: { primaryCategory: "Photo booth" },
    });

    const result = await getGbpWatchTool.handler(
      z.object(getGbpWatchTool.config.inputSchema).parse({ projectId }),
      toolContext,
    );

    expect(textContent(result)).toContain(
      "drift from the accepted state: forbidden_category Party equipment rental service",
    );
    expect(textContent(result)).toContain("No credits were used.");
    expect(getGbpWatchTool.config.annotations.readOnlyHint).toBe(true);
    expect(
      getGbpWatchTool.config.outputSchema.safeParse(result.structuredContent)
        .success,
    ).toBe(true);
    expect(mocks.runSnapshot).not.toHaveBeenCalled();
  });

  it("run_gbp_snapshot states its cost and runs in the project's market", async () => {
    expect(runGbpSnapshotTool.config.description).toMatch(
      /spends credits: about \$0\.014 per run/,
    );
    mocks.runSnapshot.mockResolvedValue({
      status: "checked",
      capturedAt: "2026-11-09T14:00:00.000Z",
      costUsd: 0.0138,
      changes: 0,
      drift: 1,
      collected: { reviews: true, questions: true, updates: false },
    });

    const result = await runGbpSnapshotTool.handler(
      z.object(runGbpSnapshotTool.config.inputSchema).parse({ projectId }),
      toolContext,
    );

    expect(mocks.runSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        market: { locationCode: 2840, languageCode: "en" },
      }),
    );
    expect(textContent(result)).toContain("Not collected this run: updates.");
    expect(
      runGbpSnapshotTool.config.outputSchema.safeParse(result.structuredContent)
        .success,
    ).toBe(true);
  });

  it("set_gbp_watch validates the accepted state before saving", () => {
    const schema = z.object(setGbpWatchTool.config.inputSchema);
    expect(
      schema.safeParse({
        projectId,
        cid: "5590594803775798319",
        expected: { hours: { monday: ["9-5"] } },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        projectId,
        cid: "5590594803775798319",
        expected: {
          primaryCategory: "Photo booth",
          forbiddenCategories: ["Party equipment rental service"],
          website: "https://socialboothlv.com/",
          hours: { monday: ["09:00-21:00"] },
        },
      }).success,
    ).toBe(true);
  });
});
