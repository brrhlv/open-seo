import { sort } from "remeda";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  AiVisibilityPromptRepository,
  type AiVisibilityPromptResultInsert,
  type AiVisibilityPromptResultRow,
  type AiVisibilityPromptRow,
} from "@/server/features/ai-visibility/repositories/AiVisibilityPromptRepository";
import { parsePlatforms } from "@/server/features/ai-visibility/services/aiVisibilityPromptResults";
import {
  analyzeAnswer,
  NORMALIZERS,
  type PromptPlatform,
} from "@/server/features/ai-visibility/services/promptAnswers";
import { createDataforseoClient } from "@/server/lib/dataforseo";

/**
 * PAI-255: running buyer prompts, shared by the cron and "run now". Every run
 * goes through the same guards: a lease on next_run_at (no double runs), at
 * most 3 attempts per platform per month (force included), at most 10 distinct
 * prompts per project per month (remove + add can't widen it), and a monthly
 * spend cap per project. Prompts run two at a time.
 */

// Same market as PAI-217; the prompts name the city themselves.
const LOCATION_CODE = 2840;
const LANGUAGE_CODE = "en";
const PERPLEXITY_MODEL = "sonar";
const PERPLEXITY_MAX_OUTPUT_TOKENS = 1024;

export const MAX_ATTEMPTS_PER_PERIOD = 3;
export const MAX_PROMPTS_PER_PERIOD = 10;
export const MONTHLY_PROMPT_COST_CAP_USD = 1;
/** Two prompts = 6 DataForSEO calls, the Workers connection limit. */
export const PROMPT_CONCURRENCY = 2;
/** A failed platform retries after this delay. */
export const RETRY_DELAY_MS = 6 * 60 * 60_000;
/** A claimed prompt is due again after this if its run never finished. */
const LEASE_MS = 15 * 60_000;

/**
 * Per-call cost (observed 2026-11-02). Also what a timed-out call is recorded
 * at: DataForSEO bills it, but the response with the real cost never arrives.
 * Perplexity is sonar at ≤1,024 output tokens; the most seen was $0.0061.
 */
export const ESTIMATED_PROMPT_COST_USD = {
  chat_gpt: 0.004,
  google_ai_mode: 0.004,
  perplexity: 0.007,
} as const satisfies Record<PromptPlatform, number>;

export const ESTIMATED_PROMPT_RUN_COST_USD = Object.values(
  ESTIMATED_PROMPT_COST_USD,
).reduce((sum, usd) => sum + usd, 0);

export type BrandContext = {
  target: { domain: string | null; names: string[] };
  competitors: { domain: string; name: string | null }[];
};

export function periodOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** 06:00 UTC on the 1st of the month after `now` (the PAI-217 anchor). */
export function nextMonthlyRunAt(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 6, 0, 0),
  ).toISOString();
}

async function fetchAnswer(
  platform: PromptPlatform,
  prompt: string,
  billingCustomer: BillingCustomerContext,
  onCost: (usd: number) => void,
): Promise<unknown> {
  const client = createDataforseoClient(billingCustomer, { onCost });
  const market = {
    prompt,
    locationCode: LOCATION_CODE,
    languageCode: LANGUAGE_CODE,
  };
  switch (platform) {
    case "chat_gpt":
      return client.aiSearch.chatGptScraper(market);
    case "google_ai_mode":
      return client.aiSearch.googleAiMode(market);
    case "perplexity":
      return client.aiSearch.llmResponse({
        userPrompt: prompt,
        modelSlug: "perplexity",
        modelName: PERPLEXITY_MODEL,
        webSearch: true,
        webSearchCountryCode: "US",
        maxOutputTokens: PERPLEXITY_MAX_OUTPUT_TOKENS,
      });
  }
}

const isTimeout = (error: unknown) =>
  error instanceof Error && error.name === "DataForSEOTimeoutError";

function errorRow(
  base: Omit<AiVisibilityPromptResultInsert, "status">,
  error: string,
  kept: AiVisibilityPromptResultRow | undefined,
): AiVisibilityPromptResultInsert {
  if (kept?.status === "ok") {
    // Keep the month's good answer; the failed call's cost still accumulates.
    const { id: _id, attempts: _attempts, ...values } = kept;
    return { ...values, costUsd: base.costUsd, capturedAt: kept.capturedAt };
  }
  return {
    ...base,
    status: "error",
    mentioned: null,
    position: null,
    brandsNamed: null,
    citedUrl: null,
    citedUrlsJson: "[]",
    competitorsJson: "[]",
    excerpt: null,
    model: null,
    error,
  };
}

export type PromptRunOutcome = {
  promptId: string;
  ran: PromptPlatform[];
  failed: PromptPlatform[];
  skipped: PromptPlatform[];
  costUsd: number;
  /** A failed platform still has attempts left this month. */
  retry: boolean;
};

const attemptsLeft = (row: AiVisibilityPromptResultRow | undefined) =>
  (row?.attempts ?? 0) < MAX_ATTEMPTS_PER_PERIOD;

/**
 * Ask one prompt on its platforms, concurrently. Skips platforms with an ok
 * row this month (unless `force`) and platforms out of attempts. A failure
 * never overwrites an ok row; it only adds its cost and an attempt.
 */
export async function runPrompt(input: {
  prompt: AiVisibilityPromptRow;
  brands: BrandContext;
  billingCustomer: BillingCustomerContext;
  period: string;
  now: Date;
  force?: boolean;
}): Promise<PromptRunOutcome> {
  const { prompt, period, now } = input;
  const platforms = parsePlatforms(prompt.platformsJson);
  const existing = await AiVisibilityPromptRepository.listResultsForPeriod(
    [prompt.id],
    period,
  );
  const existingBy = new Map(existing.map((row) => [row.platform, row]));
  const todo = platforms.filter((p) => {
    const row = existingBy.get(p);
    return attemptsLeft(row) && (input.force || row?.status !== "ok");
  });

  const settled = await Promise.all(
    todo.map(async (platform) => {
      let costUsd = 0;
      try {
        const raw = await fetchAnswer(
          platform,
          prompt.prompt,
          input.billingCustomer,
          (usd) => (costUsd += usd),
        );
        const answer = NORMALIZERS[platform](raw);
        return {
          platform,
          costUsd,
          ok: true as const,
          model: answer.model,
          analysis: analyzeAnswer(answer, input.brands),
        };
      } catch (error) {
        console.error(
          `[ai-visibility] prompt ${prompt.id} failed on ${platform}:`,
          error,
        );
        return {
          platform,
          costUsd:
            costUsd === 0 && isTimeout(error)
              ? ESTIMATED_PROMPT_COST_USD[platform]
              : costUsd,
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const capturedAt = now.toISOString();
  const rows = settled.map((r): AiVisibilityPromptResultInsert => {
    const base = {
      promptId: prompt.id,
      platform: r.platform,
      period,
      costUsd: r.costUsd,
      capturedAt,
    };
    if (!r.ok) return errorRow(base, r.error, existingBy.get(r.platform));
    return {
      ...base,
      status: "ok",
      mentioned: r.analysis.mentioned,
      position: r.analysis.position,
      brandsNamed: r.analysis.brandsNamed,
      citedUrl: r.analysis.citedUrl,
      citedUrlsJson: JSON.stringify(r.analysis.citedUrls),
      competitorsJson: JSON.stringify(r.analysis.competitors),
      excerpt: r.analysis.excerpt,
      model: r.model,
      error: null,
    };
  });
  await AiVisibilityPromptRepository.upsertResults(rows);

  const failed = settled.filter((r) => !r.ok).map((r) => r.platform);
  const errors = settled.flatMap((r) => (r.ok ? [] : [r.error]));
  await AiVisibilityPromptRepository.updatePrompt(prompt.id, {
    lastRunAt: capturedAt,
    lastError:
      errors.length > 0 ? `${failed.join(", ")}: ${errors.join("; ")}` : null,
  });

  return {
    promptId: prompt.id,
    ran: settled.filter((r) => r.ok).map((r) => r.platform),
    failed,
    skipped: platforms.filter((p) => !todo.includes(p)),
    costUsd: settled.reduce((sum, r) => sum + r.costUsd, 0),
    // This run's attempt is existing + 1; another retry needs one more left.
    retry: failed.some(
      (p) => (existingBy.get(p)?.attempts ?? 0) + 1 < MAX_ATTEMPTS_PER_PERIOD,
    ),
  };
}

/**
 * The run itself threw (not one platform): every platform without an ok row
 * gets an error row, so the same 3-attempt cap applies. Never throws.
 */
async function recordPromptFailure(
  prompt: AiVisibilityPromptRow,
  period: string,
  now: Date,
  error: unknown,
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const existing = await AiVisibilityPromptRepository.listResultsForPeriod(
      [prompt.id],
      period,
    );
    const existingBy = new Map(existing.map((row) => [row.platform, row]));
    const open = parsePlatforms(prompt.platformsJson).filter(
      (p) =>
        existingBy.get(p)?.status !== "ok" && attemptsLeft(existingBy.get(p)),
    );
    await AiVisibilityPromptRepository.upsertResults(
      open.map((platform) =>
        errorRow(
          {
            promptId: prompt.id,
            platform,
            period,
            costUsd: 0,
            capturedAt: now.toISOString(),
          },
          message,
          undefined,
        ),
      ),
    );
    await AiVisibilityPromptRepository.updatePrompt(prompt.id, {
      lastError: message,
    });
    return open.some(
      (p) => (existingBy.get(p)?.attempts ?? 0) + 1 < MAX_ATTEMPTS_PER_PERIOD,
    );
  } catch (writeErr) {
    console.error(
      `[ai-visibility] could not record failure for ${prompt.id}:`,
      writeErr,
    );
    return false;
  }
}

export type PromptSkip = {
  promptId: string;
  reason: "busy" | "monthly_prompt_limit" | "cost_cap";
};

/**
 * Run prompts of one project through every guard, two at a time. Each prompt
 * is leased first; when it finishes, next_run_at moves to the 6 h retry (a
 * platform failed and has attempts left) or to next month. Prompts skipped by
 * the monthly limits are moved to next month too.
 */
export async function runPromptsGuarded(input: {
  projectId: string;
  prompts: AiVisibilityPromptRow[];
  brands: BrandContext;
  billingCustomer: BillingCustomerContext;
  now: Date;
  force?: boolean;
}) {
  const { now } = input;
  const period = periodOf(now);
  const nextMonth = nextMonthlyRunAt(now);
  let spent = await AiVisibilityPromptRepository.sumProjectCostForPeriod(
    input.projectId,
    period,
  );
  const ranThisMonth = new Set(
    await AiVisibilityPromptRepository.listPromptIdsRunForPeriod(
      input.projectId,
      period,
    ),
  );
  const outcomes: PromptRunOutcome[] = [];
  const skipped: PromptSkip[] = [];

  const defer = async (
    prompt: AiVisibilityPromptRow,
    reason: PromptSkip["reason"],
  ) => {
    skipped.push({ promptId: prompt.id, reason });
    await AiVisibilityPromptRepository.claimPrompt({
      promptId: prompt.id,
      observedNextRunAt: prompt.nextRunAt,
      nextRunAt: nextMonth,
    });
  };

  const queue = sort(input.prompts, (a, b) =>
    (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""),
  );
  for (let i = 0; i < queue.length; i += PROMPT_CONCURRENCY) {
    const batch: AiVisibilityPromptRow[] = [];
    for (const prompt of queue.slice(i, i + PROMPT_CONCURRENCY)) {
      if (spent >= MONTHLY_PROMPT_COST_CAP_USD) {
        await defer(prompt, "cost_cap");
      } else if (
        !ranThisMonth.has(prompt.id) &&
        ranThisMonth.size >= MAX_PROMPTS_PER_PERIOD
      ) {
        await defer(prompt, "monthly_prompt_limit");
      } else if (
        await AiVisibilityPromptRepository.claimPrompt({
          promptId: prompt.id,
          observedNextRunAt: prompt.nextRunAt,
          nextRunAt: new Date(now.getTime() + LEASE_MS).toISOString(),
        })
      ) {
        ranThisMonth.add(prompt.id);
        batch.push(prompt);
      } else {
        skipped.push({ promptId: prompt.id, reason: "busy" });
      }
    }
    const results = await Promise.all(
      batch.map(async (prompt) => {
        let retry: boolean;
        let outcome: PromptRunOutcome | null = null;
        try {
          outcome = await runPrompt({
            prompt,
            brands: input.brands,
            billingCustomer: input.billingCustomer,
            period,
            now,
            force: input.force,
          });
          retry = outcome.retry;
        } catch (error) {
          console.error(
            `[ai-visibility] prompt ${prompt.id} run failed:`,
            error,
          );
          retry = await recordPromptFailure(prompt, period, now, error);
        }
        await AiVisibilityPromptRepository.updatePrompt(prompt.id, {
          nextRunAt: retry
            ? new Date(now.getTime() + RETRY_DELAY_MS).toISOString()
            : nextMonth,
        });
        return outcome;
      }),
    );
    for (const outcome of results) {
      if (!outcome) continue;
      outcomes.push(outcome);
      spent += outcome.costUsd;
    }
  }
  return {
    period,
    costUsd: outcomes.reduce((s, o) => s + o.costUsd, 0),
    outcomes,
    skipped,
    spentThisMonth: spent,
  };
}
