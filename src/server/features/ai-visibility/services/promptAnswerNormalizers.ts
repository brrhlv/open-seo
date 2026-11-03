import { z } from "zod";
import type { AI_VISIBILITY_PROMPT_PLATFORMS } from "@/db/ai-visibility.schema";

/**
 * PAI-255: one normalized shape for the three platforms' answers to a buyer
 * prompt (text, links in text order, cited sources, ChatGPT's brand
 * entities). promptAnswers.ts analyzes it.
 */

export type PromptPlatform = (typeof AI_VISIBILITY_PROMPT_PLATFORMS)[number];

export type NormalizedAnswer = {
  /** Answer markdown with images removed. */
  text: string;
  /** Inline links and resolved [n] citation markers, in text order. */
  links: { url: string; offset: number }[];
  /** Cited source URLs, in order. */
  sources: string[];
  /** Platform-tagged brand names in order (ChatGPT only). */
  entities: string[];
  model: string | null;
};

// Hosts that never stand for a vendor: search and map links, image CDNs,
// DataForSEO's own redirect host.
const IGNORED_HOST_PATTERNS = [
  /(^|\.)google\.[a-z.]+$/,
  /(^|\.)googleusercontent\.com$/,
  /(^|\.)gstatic\.com$/,
  /(^|\.)openai\.com$/,
  /(^|\.)dataforseo\.com$/,
];

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function isIgnoredHost(host: string): boolean {
  return IGNORED_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

const IMAGE_MARKDOWN = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_MARKDOWN = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;

function stripImages(markdown: string): string {
  return markdown.replace(IMAGE_MARKDOWN, "");
}

function inlineLinks(text: string): { url: string; offset: number }[] {
  return [...text.matchAll(LINK_MARKDOWN)].flatMap((match) =>
    match[1] ? [{ url: match[1], offset: match.index }] : [],
  );
}

export function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// Trust boundary: loose Zod over the DataForSEO result object.

const urlItemSchema = z
  .object({ url: z.string().nullable().optional() })
  .passthrough();

const chatGptResultSchema = z
  .object({
    model: z.string().nullable().optional(),
    markdown: z.string().nullable().optional(),
    sources: z.array(urlItemSchema).nullable().optional(),
    brand_entities: z
      .array(
        z
          .object({
            title: z.string().nullable().optional(),
            markdown: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

/** `ai_optimization/chat_gpt/llm_scraper/live/advanced` result[0]. */
export function normalizeChatGptScraper(result: unknown): NormalizedAnswer {
  const parsed = chatGptResultSchema.parse(result ?? {});
  const text = stripImages(parsed.markdown ?? "");
  return {
    text,
    links: inlineLinks(text),
    sources: (parsed.sources ?? []).flatMap((s) => (s.url ? [s.url] : [])),
    entities: (parsed.brand_entities ?? []).flatMap((e) => {
      const name = (e.markdown ?? e.title ?? "").trim();
      return name ? [name] : [];
    }),
    model: parsed.model ?? null,
  };
}

const aiModeReferenceList = z.array(urlItemSchema).nullable().optional();

const aiModeResultSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            type: z.string().nullable().optional(),
            markdown: z.string().nullable().optional(),
            references: aiModeReferenceList,
            items: z
              .array(
                z
                  .object({
                    references: aiModeReferenceList,
                    links: aiModeReferenceList,
                  })
                  .passthrough(),
              )
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

/** `serp/google/ai_mode/live/advanced` result[0]. */
export function normalizeGoogleAiMode(result: unknown): NormalizedAnswer {
  const parsed = aiModeResultSchema.parse(result ?? {});
  const overviews = (parsed.items ?? []).filter(
    (item) => item.type === "ai_overview",
  );
  const text = overviews
    .map((item) => stripImages(item.markdown ?? ""))
    .join("\n\n");
  const links = inlineLinks(text).filter((link) => {
    const host = hostOf(link.url);
    return host !== null && !isIgnoredHost(host);
  });
  const referenced = overviews.flatMap((item) => [
    ...(item.references ?? []),
    ...(item.items ?? []).flatMap((el) => [
      ...(el.references ?? []),
      ...(el.links ?? []),
    ]),
  ]);
  return {
    text,
    links,
    sources: dedupe([
      ...links.map((link) => link.url),
      ...referenced.flatMap((ref) => (ref.url ? [ref.url] : [])),
    ]),
    entities: [],
    model: null,
  };
}

const perplexityResultSchema = z
  .object({
    model_name: z.string().nullable().optional(),
    items: z
      .array(
        z
          .object({
            sections: z
              .array(
                z
                  .object({
                    text: z.string().nullable().optional(),
                    annotations: z.array(urlItemSchema).nullable().optional(),
                  })
                  .passthrough(),
              )
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

const CITATION_MARKER = /\[(\d{1,2})\]/g;

/** `ai_optimization/perplexity/llm_responses/live` result[0]. */
export function normalizePerplexity(result: unknown): NormalizedAnswer {
  const parsed = perplexityResultSchema.parse(result ?? {});
  const sections = (parsed.items ?? []).flatMap((item) => item.sections ?? []);
  let text = "";
  const links: { url: string; offset: number }[] = [];
  const annotations: string[] = [];
  for (const section of sections) {
    const base = text.length === 0 ? 0 : text.length + 2;
    const sectionText = section.text ?? "";
    const sectionUrls = (section.annotations ?? []).map((a) => a.url ?? "");
    for (const match of sectionText.matchAll(CITATION_MARKER)) {
      const url = sectionUrls[Number(match[1]) - 1];
      if (url) links.push({ url, offset: base + match.index });
    }
    annotations.push(...sectionUrls.filter(Boolean));
    text = text.length === 0 ? sectionText : `${text}\n\n${sectionText}`;
  }
  return {
    text,
    links,
    sources:
      links.length > 0
        ? dedupe(links.map((link) => link.url))
        : dedupe(annotations),
    entities: [],
    model: parsed.model_name ?? null,
  };
}

export const NORMALIZERS: Record<
  PromptPlatform,
  (result: unknown) => NormalizedAnswer
> = {
  chat_gpt: normalizeChatGptScraper,
  google_ai_mode: normalizeGoogleAiMode,
  perplexity: normalizePerplexity,
};
