import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as AiVisibilityServiceModule from "@/server/features/ai-visibility/services/AiVisibilityService";
import { createAiVisibilityTrackerTool } from "./create-ai-visibility-tracker";
import { getAiVisibilityTool } from "./get-ai-visibility";
import { runAiVisibilityCheckTool } from "./run-ai-visibility-check";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getHistory: vi.fn(),
  createTracker: vi.fn(),
  runCheck: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock(
  "@/server/features/ai-visibility/services/AiVisibilityService",
  async (importOriginal) => {
    const actual = await importOriginal<typeof AiVisibilityServiceModule>();
    return {
      ...actual,
      AiVisibilityService: {
        getHistory: mocks.getHistory,
        createTracker: mocks.createTracker,
        runCheck: mocks.runCheck,
      },
    };
  },
);

const projectId = "11111111-1111-4111-8111-111111111111";
const toolContext = makeToolContext();
const config = {
  id: "cfg-1",
  projectId,
  target: "socialboothlv.com",
  includeCompetitors: true,
  scheduleInterval: "monthly" as const,
  isActive: true,
  lastCheckedAt: "2026-09-01T06:00:00.000Z",
  nextCheckAt: "2026-10-01T06:00:00.000Z",
  lastError: null,
  createdAt: "2026-09-01 06:00:00",
};

describe("AI visibility MCP tools", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: projectId,
      domain: "socialboothlv.com",
      locationCode: 2840,
      languageCode: "en",
    });
  });

  it("get_ai_visibility reads stored snapshots with month-over-month deltas and spends nothing", async () => {
    const point = {
      period: "2026-09",
      capturedAt: "2026-09-01T06:00:00.000Z",
      mentions: 15,
      aiSearchVolume: null,
      citedPages: 2,
      shareOfVoicePct: 60,
    };
    mocks.getHistory.mockResolvedValue({
      config,
      latest: [
        {
          ...point,
          platform: "google",
          topSources: [],
          samplePrompts: [],
          shareOfVoice: null,
          billingCostUsd: 0.4,
          previous: { ...point, period: "2026-08", mentions: 10 },
          delta: { mentions: 5, citedPages: 0, shareOfVoicePct: 10 },
        },
      ],
      history: [{ ...point, platform: "google" }],
    });

    const args = z
      .object(getAiVisibilityTool.config.inputSchema)
      .parse({ projectId });
    const result = await getAiVisibilityTool.handler(args, toolContext);

    expect(textContent(result)).toContain(
      "Google AI Overview 2026-09: 15 mentions, 2 cited pages, share of voice 60.0% (vs 2026-08: mentions +5",
    );
    expect(textContent(result)).toContain("No credits were used.");
    expect(getAiVisibilityTool.config.annotations.readOnlyHint).toBe(true);
    expect(
      getAiVisibilityTool.config.outputSchema.safeParse(
        result.structuredContent,
      ).success,
    ).toBe(true);
    expect(mocks.runCheck).not.toHaveBeenCalled();
  });

  it("create_ai_visibility_tracker defaults the target to the project domain", async () => {
    mocks.createTracker.mockResolvedValue(config);

    const args = z
      .object(createAiVisibilityTrackerTool.config.inputSchema)
      .parse({ projectId });
    const result = await createAiVisibilityTrackerTool.handler(
      args,
      toolContext,
    );

    expect(mocks.createTracker).toHaveBeenCalledWith({
      projectId,
      projectDomain: "socialboothlv.com",
      target: undefined,
      includeCompetitors: undefined,
      scheduleInterval: undefined,
    });
    expect(textContent(result)).toContain("no credits were used");
  });

  it("run_ai_visibility_check states its cost up front and reports a free already-captured month", async () => {
    expect(runAiVisibilityCheckTool.config.description).toMatch(
      /spends credits: up to about \$0\.85 per run, or \$1\.05/,
    );
    mocks.runCheck.mockResolvedValue({
      status: "already_captured",
      period: "2026-10",
      costUsd: 0,
      platforms: ["chat_gpt", "google"],
    });

    const args = z
      .object(runAiVisibilityCheckTool.config.inputSchema)
      .parse({ projectId });
    const result = await runAiVisibilityCheckTool.handler(args, toolContext);

    expect(mocks.runCheck).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, force: undefined }),
    );
    expect(textContent(result)).toContain("no credits were used");
    expect(
      runAiVisibilityCheckTool.config.outputSchema.safeParse(
        result.structuredContent,
      ).success,
    ).toBe(true);
  });
});
