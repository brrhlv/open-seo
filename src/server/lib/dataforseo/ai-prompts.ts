import { createDataforseoBillingClassifier } from "@/server/lib/dataforseoBillingClassification";
import { AppError } from "@/server/lib/errors";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  isRecord,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";

/**
 * PAI-255: live answers to a buyer prompt, as a buyer would see them. The
 * result object is returned as-is; promptAnswers.ts validates the fields it
 * reads. Live mode (not the cheaper standard queue) so a run finishes inside
 * one request; see docs/specs/PAI-255-ai-visibility-prompts.md for prices.
 */

const classifyAiError = createDataforseoBillingClassifier({
  pathPrefix: "/ai_optimization/",
  billingIssueCode: "AI_SEARCH_BILLING_ISSUE",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue",
});

const classifySerpError = createDataforseoBillingClassifier({
  pathPrefix: "/serp/",
  billingIssueCode: "AI_SEARCH_BILLING_ISSUE",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue",
});

/**
 * ChatGPT scraper live answers took 14–105 s on 2026-11-02, past the shared
 * 60 s budget. An aborted call is still billed, so it gets its own ceiling.
 */
export const CHATGPT_SCRAPER_TIMEOUT_MS = 150_000;

type PromptInput = {
  prompt: string;
  locationCode: number;
  languageCode: string;
};

async function postLive(
  path: string,
  body: Record<string, unknown>,
  classify: typeof classifyAiError,
  options: { signal?: AbortSignal; maxServerErrorRetries?: number } = {},
): Promise<DataforseoApiResponse<Record<string, unknown>>> {
  const response = await dataforseoPost(path, [body], { classify, ...options });
  const task = assertOk(response, { classify, classifyPath: path });
  const result = task.result?.[0];
  if (!isRecord(result)) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      `DataForSEO ${path} returned no result`,
    );
  }
  return { data: result, billing: buildTaskBilling(task) };
}

/** ChatGPT as seen on chatgpt.com ($0.004 per live result). */
export function fetchChatGptScraperAnswer(input: PromptInput) {
  return postLive(
    "/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced",
    {
      keyword: input.prompt,
      location_code: input.locationCode,
      language_code: input.languageCode,
    },
    classifyAiError,
    // Billed per live result: a 5xx replay could pay twice.
    {
      signal: AbortSignal.timeout(CHATGPT_SCRAPER_TIMEOUT_MS),
      maxServerErrorRetries: 0,
    },
  );
}

/** Google AI Mode ($0.004 per live SERP). */
export function fetchGoogleAiModeAnswer(input: PromptInput) {
  return postLive(
    "/v3/serp/google/ai_mode/live/advanced",
    {
      keyword: input.prompt,
      location_code: input.locationCode,
      language_code: input.languageCode,
      device: "desktop",
    },
    classifySerpError,
  );
}
