import { describe, expect, it, vi } from "vitest";
import { getAiVisibilityPromptsSection } from "./aiVisibilityPrompts";

const mocks = vi.hoisted(() => ({ getResults: vi.fn() }));

vi.mock(
  "@/server/features/ai-visibility/services/AiVisibilityPromptService",
  () => ({ AiVisibilityPromptService: { getResults: mocks.getResults } }),
);

const run = {
  period: "2026-11",
  capturedAt: "2026-11-03 07:30:00",
  status: "ok",
  mentioned: true,
  position: 1,
  brandsNamed: 5,
  citedUrl: "https://socialboothlv.com/corporate-events",
  error: null,
};

describe("aiVisibility.prompts summary section", () => {
  it("returns each prompt's latest and previous run per platform with ISO timestamps", async () => {
    mocks.getResults.mockResolvedValue({
      lastRunAt: "2026-11-03 07:30:00",
      nextRunAt: "2026-12-01T06:00:00.000Z",
      items: [
        {
          id: "q1",
          prompt: "best photo booth company for a corporate event in Las Vegas",
          platforms: ["chat_gpt"],
          isActive: true,
          nextRunAt: "2026-12-01T06:00:00.000Z",
          lastRunAt: null,
          lastError: null,
          createdAt: "2026-11-03 07:20:00",
          results: [
            {
              platform: "chat_gpt",
              latest: { ...run, competitors: [], excerpt: "Social Booth LV…" },
              previous: null,
            },
          ],
        },
      ],
    });

    expect(await getAiVisibilityPromptsSection("p1")).toEqual({
      lastRunAt: "2026-11-03T07:30:00.000Z",
      nextRunAt: "2026-12-01T06:00:00.000Z",
      items: [
        {
          id: "q1",
          prompt: "best photo booth company for a corporate event in Las Vegas",
          platforms: ["chat_gpt"],
          createdAt: "2026-11-03T07:20:00.000Z",
          results: [
            {
              platform: "chat_gpt",
              latest: {
                ...run,
                capturedAt: "2026-11-03T07:30:00.000Z",
                competitors: [],
                excerpt: "Social Booth LV…",
              },
              previous: null,
            },
          ],
        },
      ],
    });
  });

  it("turns a failed read into an error code for this key only", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getResults.mockRejectedValue(new Error("no such table"));
    expect(await getAiVisibilityPromptsSection("p1")).toEqual({
      error: "internal_error",
    });
  });
});
