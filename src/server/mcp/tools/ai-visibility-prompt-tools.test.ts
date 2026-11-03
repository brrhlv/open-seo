import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as PromptServiceModule from "@/server/features/ai-visibility/services/AiVisibilityPromptService";
import { addAiVisibilityPromptsTool } from "./add-ai-visibility-prompts";
import { getAiVisibilityPromptResultsTool } from "./get-ai-visibility-prompt-results";
import { runAiVisibilityPromptsTool } from "./run-ai-visibility-prompts";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  addPrompts: vi.fn(),
  runPrompts: vi.fn(),
  getResults: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock(
  "@/server/features/ai-visibility/services/AiVisibilityPromptService",
  async (importOriginal) => {
    const actual = await importOriginal<typeof PromptServiceModule>();
    return {
      ...actual,
      AiVisibilityPromptService: {
        addPrompts: mocks.addPrompts,
        runPrompts: mocks.runPrompts,
        getResults: mocks.getResults,
      },
    };
  },
);

const projectId = "11111111-1111-4111-8111-111111111111";
const toolContext = makeToolContext();
const run = {
  period: "2026-11",
  capturedAt: "2026-11-03T07:30:00.000Z",
  status: "ok" as const,
  mentioned: true,
  position: 1,
  brandsNamed: 5,
  citedUrl: "https://socialboothlv.com/corporate-events",
  error: null,
};

describe("AI visibility buyer prompt MCP tools", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: projectId,
      domain: "socialboothlv.com",
      locationCode: 2840,
      languageCode: "en",
    });
  });

  it("add and run state the per-prompt cost up front", async () => {
    expect(addAiVisibilityPromptsTool.config.description).toMatch(
      /about \$0\.015 per prompt per month/,
    );
    expect(runAiVisibilityPromptsTool.config.description).toMatch(
      /spends credits: about \$0\.015 per prompt/,
    );
    mocks.addPrompts.mockResolvedValue({
      added: 2,
      reactivated: 0,
      unchanged: 0,
      prompts: [{ id: "a" }, { id: "b" }],
    });
    const args = z
      .object(addAiVisibilityPromptsTool.config.inputSchema)
      .parse({ projectId, prompts: ["one prompt", "two prompt"] });
    const result = await addAiVisibilityPromptsTool.handler(args, toolContext);
    expect(textContent(result)).toContain(
      "2 prompts will run on the next cron tick (about $0.030)",
    );
  });

  it("run passes the project domain and reports the real cost", async () => {
    mocks.runPrompts.mockResolvedValue({
      period: "2026-11",
      costUsd: 0.014,
      outcomes: [
        {
          promptId: "a",
          ran: ["chat_gpt", "google_ai_mode"],
          failed: ["perplexity"],
          skipped: [],
          costUsd: 0.014,
          retry: true,
        },
      ],
      skipped: [{ promptId: "b", reason: "busy" }],
    });
    const args = z
      .object(runAiVisibilityPromptsTool.config.inputSchema)
      .parse({ projectId });
    const result = await runAiVisibilityPromptsTool.handler(args, toolContext);
    expect(mocks.runPrompts).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        projectDomain: "socialboothlv.com",
      }),
    );
    expect(textContent(result)).toContain(
      "2 answers stored, 0 already captured (free), 1 failed",
    );
    expect(textContent(result)).toContain("$0.0140");
    expect(textContent(result)).toContain("1 prompt not run (busy)");
  });

  it("get_ai_visibility_prompt_results reads stored runs with the previous month and spends nothing", async () => {
    mocks.getResults.mockResolvedValue({
      lastRunAt: run.capturedAt,
      nextRunAt: "2026-12-01T06:00:00.000Z",
      items: [
        {
          id: "a",
          prompt: "best photo booth company for a corporate event in Las Vegas",
          platforms: ["chat_gpt"],
          results: [
            {
              platform: "chat_gpt",
              latest: {
                ...run,
                competitors: [
                  {
                    domain: "boothmeuplv.com",
                    name: "Booth Me Up LV",
                    position: 2,
                  },
                ],
                excerpt: null,
              },
              previous: { ...run, period: "2026-10", position: 3 },
            },
          ],
        },
      ],
    });
    const args = z
      .object(getAiVisibilityPromptResultsTool.config.inputSchema)
      .parse({ projectId });
    const result = await getAiVisibilityPromptResultsTool.handler(
      args,
      toolContext,
    );
    expect(textContent(result)).toContain(
      "ChatGPT 2026-11: #1 of 5, cited https://socialboothlv.com/corporate-events, competitors Booth Me Up LV #2 (was #3 of 5 in 2026-10)",
    );
    expect(textContent(result)).toContain("No credits were used.");
    expect(
      getAiVisibilityPromptResultsTool.config.outputSchema.safeParse(
        result.structuredContent,
      ).success,
    ).toBe(true);
  });
});
