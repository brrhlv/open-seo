import { AI_VISIBILITY_PROMPT_PLATFORMS } from "@/db/ai-visibility.schema";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AiVisibilityRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import { AiVisibilityPromptRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityPromptRepository";
import {
  getPromptResults,
  toPromptView,
  type PromptView,
} from "@/server/features/ai-visibility/services/aiVisibilityPromptResults";
import type { PromptPlatform } from "@/server/features/ai-visibility/services/promptAnswers";
import {
  MONTHLY_PROMPT_COST_CAP_USD,
  periodOf,
  runPromptsGuarded,
  type BrandContext,
} from "@/server/features/ai-visibility/services/promptRuns";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
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

// Re-exported for the MCP tools and the cron.
export {
  ESTIMATED_PROMPT_RUN_COST_USD,
  MONTHLY_PROMPT_COST_CAP_USD,
} from "@/server/features/ai-visibility/services/promptRuns";

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

/**
 * "Run now" (MCP): every active prompt, or the given ones, through the same
 * guards as the cron (lease, attempts, monthly prompt limit, spend cap), two
 * at a time. Refuses outright when this month's spend is already at the cap.
 */
async function runPrompts(input: {
  projectId: string;
  projectDomain: string | null;
  billingCustomer: BillingCustomerContext;
  promptIds?: string[];
  force?: boolean;
  now?: Date;
}) {
  const now = input.now ?? new Date();
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
  const spent = await AiVisibilityPromptRepository.sumProjectCostForPeriod(
    input.projectId,
    periodOf(now),
  );
  if (spent >= MONTHLY_PROMPT_COST_CAP_USD) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Buyer prompts already cost $${spent.toFixed(2)} this month, at the $${MONTHLY_PROMPT_COST_CAP_USD.toFixed(2)} monthly cap. They run again next month.`,
    );
  }
  await assertHostedPaidPlan(input.billingCustomer.organizationId);
  return runPromptsGuarded({
    projectId: input.projectId,
    prompts,
    brands,
    billingCustomer: input.billingCustomer,
    now,
    force: input.force,
  });
}

export const AiVisibilityPromptService = {
  listPrompts,
  addPrompts,
  removePrompts,
  loadBrandContext,
  runPrompts,
  getResults: getPromptResults,
};
