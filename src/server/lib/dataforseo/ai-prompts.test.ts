import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHATGPT_SCRAPER_TIMEOUT_MS,
  fetchChatGptScraperAnswer,
  fetchGoogleAiModeAnswer,
} from "./ai-prompts";

const mocks = vi.hoisted(() => ({ dataforseoPost: vi.fn() }));
vi.mock("@/server/lib/dataforseo/core", () => ({
  dataforseoPost: mocks.dataforseoPost,
}));

const ok = {
  status_code: 20000,
  tasks: [
    { status_code: 20000, cost: 0.004, path: ["v3"], result: [{ a: 1 }] },
  ],
};
const input = { prompt: "p", locationCode: 2840, languageCode: "en" };

describe("buyer prompt fetchers", () => {
  beforeEach(() => {
    mocks.dataforseoPost.mockResolvedValue(ok);
  });

  it("gives the ChatGPT scraper its own 150 s budget and never replays it", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await fetchChatGptScraperAnswer(input);
    expect(CHATGPT_SCRAPER_TIMEOUT_MS).toBe(150_000);
    expect(timeout).toHaveBeenCalledWith(150_000);
    expect(mocks.dataforseoPost.mock.calls[0]?.[2]).toMatchObject({
      signal: expect.any(AbortSignal),
      maxServerErrorRetries: 0,
    });
  });

  it("leaves AI Mode on the shared default timeout", async () => {
    await fetchGoogleAiModeAnswer(input);
    expect(mocks.dataforseoPost.mock.calls[0]?.[2]?.signal).toBeUndefined();
  });
});
