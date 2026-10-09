import type { BillingCustomerContext } from "@/server/billing/subscription";
import { getBrandLookup } from "@/server/features/ai-search/services/brandLookup";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import {
  AiVisibilityRepository,
  type AiVisibilityConfig,
} from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import {
  AI_VISIBILITY_PLATFORMS,
  snapshotRowsFromLookup,
  summarizeSnapshots,
  type AiVisibilityHistory,
  type AiVisibilityPlatform,
} from "@/server/features/ai-visibility/services/aiVisibilitySnapshots";
import { AppError } from "@/server/lib/errors";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { detectTarget } from "@/shared/targetDetection";

/**
 * PAI-217: persistent AI visibility. A run is one Brand Lookup (ChatGPT +
 * Google AI Overview via DataForSEO LLM Mentions) stored as one row per
 * platform per calendar month. Reads are D1-only and never metered.
 */

// Brand Lookup's own competitor cap (brandLookupInputSchema).
const MAX_COMPETITORS = 5;
// Brand Lookup's UI hardcodes US/en; using the same market lets a tracked run
// share the R2 cache entry with a manual lookup of the same target.
const LOCATION_CODE = 2840;
const LANGUAGE_CODE = "en";
const DEFAULT_HISTORY_MONTHS = 12;

// Placeholder or tracking-only brands where a competitor comparison is not
// worth the extra cross_aggregated calls (PAI-217 open decision, 2026-09-04).
const NO_COMPETITORS_BY_DEFAULT = new Set([
  "flipwithaj.com",
  "ajgventuregroup.com",
  "desertmedicalconsulting.com",
]);

/**
 * Upper-bound DataForSEO cost of one run, matching Brand Lookup's on-screen
 * estimate (BrandLookupSearchCard: $0.85 for the 6 base calls, +$0.20 for the
 * two cross_aggregated calls when competitors are compared). Small brands
 * return fewer than 100 mention rows and cost less. The stored
 * billing_cost_usd is the real figure; this only feeds tool descriptions.
 */
export const ESTIMATED_RUN_COST_USD = {
  withoutCompetitors: 0.85,
  withCompetitors: 1.05,
} as const;

// ---------------------------------------------------------------------------
// Schedule helpers
// ---------------------------------------------------------------------------

/** UTC calendar month as YYYY-MM. */
function periodOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** 06:00 UTC on the 1st of the month after `now`. */
export function nextMonthlyCheckAt(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 6, 0, 0),
  ).toISOString();
}

function defaultIncludeCompetitors(target: string): boolean {
  return !NO_COMPETITORS_BY_DEFAULT.has(detectTarget(target).value);
}

// ---------------------------------------------------------------------------
// Tracker config
// ---------------------------------------------------------------------------

async function getConfig(projectId: string) {
  return AiVisibilityRepository.getConfigForProject(projectId);
}

async function createTracker(input: {
  projectId: string;
  projectDomain: string | null;
  target?: string;
  includeCompetitors?: boolean;
  scheduleInterval?: "monthly" | "manual";
  now?: Date;
}): Promise<AiVisibilityConfig> {
  const target = input.target?.trim() || input.projectDomain;
  if (!target) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Provide a target brand or domain, or set the project's domain first",
    );
  }
  const scheduleInterval = input.scheduleInterval ?? "monthly";
  return AiVisibilityRepository.upsertConfig({
    projectId: input.projectId,
    target,
    includeCompetitors:
      input.includeCompetitors ?? defaultIncludeCompetitors(target),
    scheduleInterval,
    isActive: true,
    nextCheckAt:
      scheduleInterval === "monthly"
        ? nextMonthlyCheckAt(input.now ?? new Date())
        : null,
  });
}

/** The Brand Lookup "Track this" toggle. Off keeps the stored history. */
async function setTracking(input: {
  projectId: string;
  projectDomain: string | null;
  target: string;
  active: boolean;
  now?: Date;
}): Promise<AiVisibilityConfig | null> {
  const existing = await AiVisibilityRepository.getConfigForProject(
    input.projectId,
  );
  if (!input.active) {
    if (!existing) return null;
    await AiVisibilityRepository.updateConfig(existing.id, {
      isActive: false,
    });
    return { ...existing, isActive: false };
  }
  return createTracker({
    projectId: input.projectId,
    projectDomain: input.projectDomain,
    target: input.target,
    includeCompetitors: existing?.includeCompetitors,
    scheduleInterval: existing?.scheduleInterval,
    now: input.now,
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

type AiVisibilityRunResult = {
  status: "checked" | "already_captured";
  period: string;
  costUsd: number;
  platforms: AiVisibilityPlatform[];
};

/**
 * Same gate as the Brand Lookup page: hosted free plans cannot spend on AI
 * visibility; self-hosted deployments pay DataForSEO directly. The billing
 * module is loaded only in hosted mode — it is heavy and self-host never
 * needs it.
 */
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
 * Snapshot the tracker's target for the current month. Without `force`, a
 * month that already has a row for every platform returns without calling
 * DataForSEO. With `force`, Brand Lookup's 24 h R2 cache still makes a repeat
 * inside a day free; the stored row is replaced and its cost accumulates.
 */
async function runCheck(input: {
  projectId: string;
  billingCustomer: BillingCustomerContext;
  force?: boolean;
  now?: Date;
}): Promise<AiVisibilityRunResult> {
  const config = await AiVisibilityRepository.getConfigForProject(
    input.projectId,
  );
  if (!config) {
    throw new AppError(
      "NOT_FOUND",
      "No AI visibility tracker for this project. Create one first.",
    );
  }
  const now = input.now ?? new Date();
  const period = periodOf(now);

  if (!input.force) {
    const existing = await AiVisibilityRepository.listSnapshotsForPeriod(
      input.projectId,
      period,
    );
    const captured = new Set(existing.map((row) => row.platform));
    if (AI_VISIBILITY_PLATFORMS.every((p) => captured.has(p))) {
      return {
        status: "already_captured",
        period,
        costUsd: 0,
        platforms: [...AI_VISIBILITY_PLATFORMS],
      };
    }
  }

  await assertHostedPaidPlan(input.billingCustomer.organizationId);

  const competitors = config.includeCompetitors
    ? (await ProjectContextRepository.listCompetitors(input.projectId))
        .map((row) => row.domain)
        .slice(0, MAX_COMPETITORS)
    : [];

  let costUsd = 0;
  const result = await getBrandLookup(
    {
      projectId: input.projectId,
      query: config.target,
      competitors,
      locationCode: LOCATION_CODE,
      languageCode: LANGUAGE_CODE,
    },
    input.billingCustomer,
    { onCost: (usd) => (costUsd += usd) },
  );

  const rows = snapshotRowsFromLookup(result, {
    projectId: input.projectId,
    period,
    capturedAt: now.toISOString(),
    costUsd,
  });
  if (rows.length === 0) {
    await AiVisibilityRepository.updateConfig(config.id, {
      lastError: "Every platform failed",
    });
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "DataForSEO returned no AI visibility data for any platform. Try again later.",
    );
  }

  await AiVisibilityRepository.upsertSnapshots(rows);
  await AiVisibilityRepository.updateConfig(config.id, {
    lastCheckedAt: now.toISOString(),
    lastError: null,
  });
  return {
    status: "checked",
    period,
    costUsd,
    platforms: rows.map((row) => row.platform),
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function getHistory(
  projectId: string,
  months = DEFAULT_HISTORY_MONTHS,
): Promise<AiVisibilityHistory> {
  const [config, rows] = await Promise.all([
    AiVisibilityRepository.getConfigForProject(projectId),
    AiVisibilityRepository.listRecentSnapshots(
      projectId,
      months * AI_VISIBILITY_PLATFORMS.length,
    ),
  ]);
  return { config, ...summarizeSnapshots(rows) };
}

export const AiVisibilityService = {
  getConfig,
  createTracker,
  setTracking,
  runCheck,
  getHistory,
};
