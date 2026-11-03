import { AI_VISIBILITY_PROMPT_PLATFORMS } from "@/db/ai-visibility.schema";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AiVisibilityRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import {
  AiVisibilityPromptRepository,
  type AiVisibilityPromptResultInsert,
  type AiVisibilityPromptRow,
} from "@/server/features/ai-visibility/repositories/AiVisibilityPromptRepository";
import {
  getPromptResults,
  parsePlatforms,
  toPromptView,
  type PromptView,
} from "@/server/features/ai-visibility/services/aiVisibilityPromptResults";
import {
  analyzeAnswer,
  NORMALIZERS,
  type PromptPlatform,
} from "@/server/features/ai-visibility/services/promptAnswers";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { detectTarget } from "@/shared/targetDetection";

/**
 * PAI-255: buyer prompts. Each active prompt is asked of ChatGPT (scraper),
 * Google AI Mode and Perplexity once a month; one result row per platform
 * per month records whether the brand was named, its position, the cited
 * page and the tracked competitors named. Reads are D1-only.
 */

export const MAX_ACTIVE_PROMPTS = 10;
const MIN_PROMPT_LENGTH = 3;
const MAX_PROMPT_LENGTH = 300;
// Same market as PAI-217; the prompts name the city themselves.
const LOCATION_CODE = 2840;
const LANGUAGE_CODE = "en";
const PERPLEXITY_MODEL = "sonar";
const PERPLEXITY_MAX_OUTPUT_TOKENS = 1024;
// A failed platform retries after this delay, up to MAX_ATTEMPTS per month.
export const RETRY_DELAY_MS = 6 * 60 * 60_000;
export const MAX_ATTEMPTS_PER_PERIOD = 3;

/** Per-prompt cost of one monthly run on all three platforms (observed 2026-11-02). */
const ESTIMATED_PROMPT_COST_USD = {
  chat_gpt: 0.004,
  google_ai_mode: 0.004,
  perplexity: 0.006,
} as const satisfies Record<PromptPlatform, number>;

export const ESTIMATED_PROMPT_RUN_COST_USD = Object.values(
  ESTIMATED_PROMPT_COST_USD,
).reduce((sum, usd) => sum + usd, 0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function periodOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** 06:00 UTC on the 1st of the month after `now` (the PAI-217 anchor). */
export function nextMonthlyRunAt(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 6, 0, 0),
  ).toISOString();
}

function normalizePromptText(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

function platformsJson(platforms: readonly PromptPlatform[]): string {
  const set = new Set(platforms);
  return JSON.stringify(
    AI_VISIBILITY_PROMPT_PLATFORMS.filter((p) => set.has(p)),
  );
}

// ---------------------------------------------------------------------------
// Prompt list
// ---------------------------------------------------------------------------

async function listPrompts(
  projectId: string,
  options: { includeInactive?: boolean } = {},
): Promise<PromptView[]> {
  const rows = await AiVisibilityPromptRepository.listPrompts(
    projectId,
    options,
  );
  return rows.map(toPromptView);
}

/**
 * Adds prompts (trimmed, whitespace collapsed, deduped). An inactive prompt
 * with the same text is reactivated. New and reactivated prompts are due now,
 * so the next cron tick baselines them; prompts already active keep their
 * schedule and only take the new platform list when one is given.
 */
async function addPrompts(input: {
  projectId: string;
  prompts: string[];
  platforms?: PromptPlatform[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const texts = [...new Set(input.prompts.map(normalizePromptText))];
  const bad = texts.find(
    (t) => t.length < MIN_PROMPT_LENGTH || t.length > MAX_PROMPT_LENGTH,
  );
  if (bad !== undefined) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Each prompt must be ${MIN_PROMPT_LENGTH}–${MAX_PROMPT_LENGTH} characters`,
    );
  }
  const platforms = input.platforms?.length
    ? input.platforms
    : AI_VISIBILITY_PROMPT_PLATFORMS;

  const existing = await AiVisibilityPromptRepository.listPrompts(
    input.projectId,
    { includeInactive: true },
  );
  const byText = new Map(existing.map((row) => [row.prompt, row]));
  const toInsert = texts.filter((t) => !byText.has(t));
  const toReactivate = texts.flatMap((t) => {
    const row = byText.get(t);
    return row && !row.isActive ? [row] : [];
  });
  const alreadyActive = texts.flatMap((t) => {
    const row = byText.get(t);
    return row?.isActive ? [row] : [];
  });

  const activeAfter =
    existing.filter((row) => row.isActive).length +
    toInsert.length +
    toReactivate.length;
  if (activeAfter > MAX_ACTIVE_PROMPTS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `A project can track at most ${MAX_ACTIVE_PROMPTS} active prompts (this would make ${activeAfter}). Remove some first.`,
    );
  }

  const nowIso = now.toISOString();
  const json = platformsJson(platforms);
  await AiVisibilityPromptRepository.insertPrompts(
    toInsert.map((prompt, index) => ({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      prompt,
      platformsJson: json,
      isActive: true,
      nextRunAt: nowIso,
      // One millisecond apart so the list keeps the order they were given.
      createdAt: new Date(now.getTime() + index).toISOString(),
    })),
  );
  for (const row of toReactivate) {
    await AiVisibilityPromptRepository.updatePrompt(row.id, {
      isActive: true,
      platformsJson: json,
      nextRunAt: nowIso,
      lastError: null,
    });
  }
  if (input.platforms?.length) {
    for (const row of alreadyActive) {
      await AiVisibilityPromptRepository.updatePrompt(row.id, {
        platformsJson: json,
      });
    }
  }

  return {
    added: toInsert.length,
    reactivated: toReactivate.length,
    unchanged: alreadyActive.length,
    prompts: await listPrompts(input.projectId),
  };
}

async function removePrompts(projectId: string, promptIds: string[]) {
  const removed = await AiVisibilityPromptRepository.deactivatePrompts(
    projectId,
    promptIds,
  );
  return { removed };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

type BrandContext = {
  target: { domain: string | null; names: string[] };
  competitors: { domain: string; name: string | null }[];
};

async function loadBrandContext(
  projectId: string,
  projectDomain: string | null,
): Promise<BrandContext> {
  const [config, competitors] = await Promise.all([
    AiVisibilityRepository.getConfigForProject(projectId),
    ProjectContextRepository.listCompetitors(projectId),
  ]);
  if (!config) {
    throw new AppError(
      "NOT_FOUND",
      "No AI visibility tracker for this project. Create one first (create_ai_visibility_tracker).",
    );
  }
  const detected = detectTarget(config.target);
  const domain = detected.type === "domain" ? detected.value : projectDomain;
  return {
    target: {
      domain,
      names: detected.type === "keyword" ? [detected.value] : [],
    },
    competitors: competitors.map((c) => ({ domain: c.domain, name: c.name })),
  };
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

/** Same gate as PAI-217: hosted free plans cannot spend on AI visibility. */
async function assertHostedPaidPlan(organizationId: string): Promise<void> {
  if (!(await isHostedServerAuthMode())) return;
  const { customerHasPaidPlan } = await import("@/server/billing/subscription");
  if (await customerHasPaidPlan(organizationId, { retryDenied: true })) return;
  throw new AppError(
    "PAYMENT_REQUIRED",
    "Upgrade to the paid plan to use AI Visibility",
  );
}

type PromptRunOutcome = {
  promptId: string;
  ran: PromptPlatform[];
  failed: PromptPlatform[];
  skipped: PromptPlatform[];
  costUsd: number;
  /** Lowest attempt count among failed platforms this period (for retry). */
  failedAttempts: number;
};

/**
 * Ask one prompt on its platforms, concurrently. Platforms that already have
 * an ok row this period are skipped unless `force`. A failure never
 * overwrites an ok row from earlier in the month; it only adds its cost.
 */
async function runPrompt(input: {
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
  const todo = platforms.filter(
    (p) => input.force || existingBy.get(p)?.status !== "ok",
  );
  const skipped = platforms.filter((p) => !todo.includes(p));

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
          costUsd,
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const capturedAt = now.toISOString();
  const rows: AiVisibilityPromptResultInsert[] = settled.map((r) => {
    const base = {
      promptId: prompt.id,
      platform: r.platform,
      period,
      costUsd: r.costUsd,
      capturedAt,
    };
    if (r.ok) {
      return {
        ...base,
        status: "ok" as const,
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
    }
    const kept = existingBy.get(r.platform);
    if (kept?.status === "ok") {
      // Keep the month's good answer; the re-run's cost still accumulates.
      const { id: _id, attempts: _attempts, ...values } = kept;
      return { ...values, costUsd: r.costUsd, capturedAt: kept.capturedAt };
    }
    return {
      ...base,
      status: "error" as const,
      mentioned: null,
      position: null,
      brandsNamed: null,
      citedUrl: null,
      citedUrlsJson: "[]",
      competitorsJson: "[]",
      excerpt: null,
      model: null,
      error: r.error,
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
    skipped,
    costUsd: settled.reduce((sum, r) => sum + r.costUsd, 0),
    failedAttempts:
      failed.length === 0
        ? 0
        : Math.min(
            ...failed.map((p) => (existingBy.get(p)?.attempts ?? 0) + 1),
          ),
  };
}

/** "Run now" (MCP): every active prompt, or the given ones, at most 10. */
async function runPrompts(input: {
  projectId: string;
  projectDomain: string | null;
  billingCustomer: BillingCustomerContext;
  promptIds?: string[];
  force?: boolean;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const period = periodOf(now);
  const brands = await loadBrandContext(input.projectId, input.projectDomain);
  const active = await AiVisibilityPromptRepository.listPrompts(
    input.projectId,
  );
  const wanted = input.promptIds ? new Set(input.promptIds) : null;
  const prompts = active.filter((row) => !wanted || wanted.has(row.id));
  if (prompts.length === 0) {
    throw new AppError(
      "NOT_FOUND",
      "No active buyer prompts matched. Add some with add_ai_visibility_prompts.",
    );
  }
  if (prompts.length > MAX_ACTIVE_PROMPTS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Run at most ${MAX_ACTIVE_PROMPTS} prompts at a time`,
    );
  }
  await assertHostedPaidPlan(input.billingCustomer.organizationId);

  const outcomes = await Promise.all(
    prompts.map((prompt) =>
      runPrompt({
        prompt,
        brands,
        billingCustomer: input.billingCustomer,
        period,
        now,
        force: input.force,
      }),
    ),
  );
  return {
    period,
    costUsd: outcomes.reduce((sum, o) => sum + o.costUsd, 0),
    outcomes,
  };
}

export const AiVisibilityPromptService = {
  listPrompts,
  addPrompts,
  removePrompts,
  loadBrandContext,
  runPrompt,
  runPrompts,
  getResults: getPromptResults,
};
