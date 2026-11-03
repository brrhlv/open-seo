import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzeAnswer,
  normalizeChatGptScraper,
  normalizeGoogleAiMode,
  normalizePerplexity,
  type NormalizedAnswer,
} from "./promptAnswers";

// Real DataForSEO responses for SBLV buyer prompts (2026-11-02), trimmed to
// the fields the parser reads.
const FIXTURES: Record<string, unknown> = JSON.parse(
  readFileSync(
    "src/server/features/ai-visibility/services/__fixtures__/prompt-answers.json",
    "utf8",
  ),
);

const BRANDS = {
  target: { domain: "socialboothlv.com" },
  competitors: [
    { domain: "boothmeuplv.com", name: "Booth Me Up LV" },
    { domain: "lvphoto.co", name: "LV Photo" },
    { domain: "boothnv.com", name: "BoothNV Photo Booth Rentals" },
    { domain: "joysquad.com", name: "Joy Squad" },
    { domain: "thesocialboothco.com", name: "The Social Booth Co" },
  ],
};

function answer(text: string, extra: Partial<NormalizedAnswer> = {}) {
  return {
    text,
    links: [],
    sources: [],
    entities: [],
    model: null,
    ...extra,
  } satisfies NormalizedAnswer;
}

describe("buyer prompt answers", () => {
  it("ChatGPT: ranks by tagged entities and finds the cited page", () => {
    const result = analyzeAnswer(
      normalizeChatGptScraper(FIXTURES.chat_gpt_1),
      BRANDS,
    );
    expect(result).toMatchObject({
      mentioned: true,
      position: 1,
      brandsNamed: 5,
      citedUrl: "https://socialboothlv.com/corporate-events",
      competitors: [
        { domain: "boothmeuplv.com", position: 2 },
        { domain: "lvphoto.co", position: 5 },
      ],
    });
    expect(result.excerpt).toContain("Social Booth LV");
  });

  it("ChatGPT: strips utm parameters from the cited page", () => {
    const result = analyzeAnswer(
      normalizeChatGptScraper(FIXTURES.chat_gpt_2),
      BRANDS,
    );
    expect(result.position).toBe(2);
    expect(result.citedUrl).toBe(
      "https://socialboothlv.com/trade-show-booth-rental-las-vegas",
    );
  });

  it("Google AI Mode: an untracked vendor listed first pushes us to #2; Maps links are ignored", () => {
    const normalized = normalizeGoogleAiMode(FIXTURES.google_ai_mode_1);
    expect(normalized.links.some((l) => l.url.includes("google.com"))).toBe(
      false,
    );
    expect(analyzeAnswer(normalized, BRANDS)).toMatchObject({
      mentioned: true,
      position: 2,
      brandsNamed: 4,
      citedUrl: "https://socialboothlv.com/",
      competitors: [{ domain: "joysquad.com", position: 4 }],
    });
  });

  it("Google AI Mode: an answer naming no vendor is not a mention", () => {
    const result = analyzeAnswer(
      normalizeGoogleAiMode(FIXTURES.google_ai_mode_6),
      BRANDS,
    );
    expect(result).toMatchObject({
      mentioned: false,
      position: null,
      brandsNamed: 0,
      citedUrl: null,
    });
    expect(result.excerpt?.startsWith("For a corporate event")).toBe(true);
  });

  it("Perplexity: [n] markers resolve to annotations; directories are not brands", () => {
    const missed = analyzeAnswer(
      normalizePerplexity(FIXTURES.perplexity_1),
      BRANDS,
    );
    expect(missed).toMatchObject({
      mentioned: false,
      position: null,
      brandsNamed: 4,
      citedUrl: null,
    });
    expect(missed.excerpt?.startsWith("**Milestone Media**")).toBe(true);

    const hit = analyzeAnswer(
      normalizePerplexity(FIXTURES.perplexity_2),
      BRANDS,
    );
    expect(hit).toMatchObject({
      mentioned: true,
      position: 1,
      citedUrl: "https://socialboothlv.com/",
    });
  });

  it("names match whole words only, never inside a link target", () => {
    const result = analyzeAnswer(
      answer(
        "Try LV Photography or The Social Booth Co. See [reviews](https://www.thumbtack.com/nv/social-booth-lv/service/1).",
        {
          links: [
            {
              url: "https://www.thumbtack.com/nv/social-booth-lv/service/1",
              offset: 50,
            },
          ],
        },
      ),
      BRANDS,
    );
    expect(result.mentioned).toBe(false);
    expect(result.competitors.map((c) => c.domain)).toEqual([
      "thesocialboothco.com",
    ]);
  });

  it("looks each ChatGPT entity up after the previous one", () => {
    const result = analyzeAnswer(
      answer(
        "Look for Las Vegas photo booth companies. **1. Social Booth LV** first. **2. Las Vegas Photo** second.",
        { entities: ["Social Booth LV", "Las Vegas Photo"] },
      ),
      BRANDS,
    );
    expect(result).toMatchObject({ position: 1, brandsNamed: 2 });
  });
});
