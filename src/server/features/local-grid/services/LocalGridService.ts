import { sort } from "remeda";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  LocalGridRepository,
  type LocalGridConfig,
} from "@/server/features/local-grid/repositories/LocalGridRepository";
import { getLatest } from "@/server/features/local-grid/services/localGridHistory";
import { runRankGrid } from "@/server/features/local-grid/services/localRankGrid";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";

/**
 * CLIENT-SBLV-191: the stored Maps rank grid. A run is one grid per keyword
 * (gridSize² Maps searches) stored as one snapshot per keyword per UTC month,
 * the business matched by place_id / cid only. Reads are D1-only.
 */

export const MAX_GRID_KEYWORDS = 10;
// A run makes its Maps calls inline in one request or cron tick. Workers Free
// allows 50 subrequests per invocation and the cron tick shares them with the
// rank and AI-visibility loops, so a run stays at or under 27 calls: three
// 3×3 keywords. A 5×5 grid (25 calls per keyword) needs Workers Paid.
const MAX_CALLS_PER_RUN = 27;
const MAX_GRID_POINTS = 9;
// A keyword that fails or comes back degraded this many times in a month is
// left until next month, so it cannot starve the others.
export const MAX_ATTEMPTS_PER_MONTH = 3;
// A snapshot with more than this share of failed points is not final.
const MAX_FAILED_SHARE = 1 / 3;
// A run holds the tracker for this long (cron and MCP alike).
const LEASE_MS = 10 * 60_000;
// Failed or degraded keywords are retried after this delay.
const RETRY_DELAY_MS = 6 * 60 * 60_000;
// These mean every further call fails (and may bill) the same way.
const ABORT_ERROR_CODES = new Set<string>([
  "INSUFFICIENT_CREDITS",
  "DATAFORSEO_AUTH_FAILED",
]);
// Maps live advanced, verified 2026-11-02 (9 calls, $0.018).
const MAPS_CALL_COST_USD = 0.002;

type GridDevice = "desktop" | "mobile";

/** UTC calendar month as YYYY-MM. */
function periodOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/**
 * 07:00 UTC on the 2nd: this month's when it is still ahead, else next
 * month's. The 1st belongs to the AI-visibility run (PAI-217).
 */
function nextGridCheckAt(now: Date): string {
  const thisMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 2, 7);
  if (now.getTime() < thisMonth) return new Date(thisMonth).toISOString();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2, 7),
  ).toISOString();
}

/** Keywords one run may grid: the call budget over the grid's points. */
export function keywordsPerRun(gridSize: number): number {
  return Math.max(1, Math.floor(MAX_CALLS_PER_RUN / (gridSize * gridSize)));
}

export function estimateGridCostUsd(gridSize: number, keywords: number) {
  return Number(
    (gridSize * gridSize * keywords * MAPS_CALL_COST_USD).toFixed(4),
  );
}

function cleanKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    // Lowercased on write, so tracker keywords, snapshots and their unique
    // index all compare the same way.
    const keyword = raw.trim().replace(/\s+/g, " ").toLowerCase();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push(keyword);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tracker config
// ---------------------------------------------------------------------------

async function createTracker(input: {
  projectId: string;
  keywords: string[];
  target: { placeId?: string; cid?: string; name?: string };
  center: { latitude: number; longitude: number };
  gridSize?: 3 | 5;
  spacingKm?: number;
  device?: GridDevice;
  languageCode?: string;
  scheduleInterval?: "monthly" | "manual";
  now?: Date;
}): Promise<{ config: LocalGridConfig; keywords: string[] }> {
  if (!input.target.placeId && !input.target.cid) {
    throw new AppError(
      "VALIDATION_ERROR",
      "The stored grid matches the business by placeId or cid; provide at least one.",
    );
  }
  const keywords = cleanKeywords(input.keywords);
  if (keywords.length === 0 || keywords.length > MAX_GRID_KEYWORDS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Provide 1 to ${MAX_GRID_KEYWORDS} keywords.`,
    );
  }
  const gridSize = input.gridSize ?? 3;
  if (gridSize * gridSize > MAX_GRID_POINTS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `A ${gridSize}x${gridSize} grid is ${gridSize * gridSize} Maps calls per keyword, more than a Workers Free cron tick can make beside the rank checks. Use 3x3 until the Worker is on a paid plan.`,
    );
  }
  const scheduleInterval = input.scheduleInterval ?? "monthly";
  const config = await LocalGridRepository.upsertConfig({
    projectId: input.projectId,
    targetName: input.target.name ?? null,
    targetPlaceId: input.target.placeId ?? null,
    targetCid: input.target.cid ?? null,
    centerLatitude: input.center.latitude,
    centerLongitude: input.center.longitude,
    gridSize,
    spacingKm: input.spacingKm ?? 2,
    device: input.device ?? "mobile",
    languageCode: input.languageCode ?? "en",
    scheduleInterval,
    isActive: true,
    nextCheckAt:
      scheduleInterval === "monthly"
        ? nextGridCheckAt(input.now ?? new Date())
        : null,
  });
  await LocalGridRepository.replaceKeywords(config.id, keywords);
  return { config, keywords };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

type LocalGridKeywordRun = {
  keyword: string;
  costUsd: number;
  pointsFound: number;
  pointsSearched: number;
  pointsFailed: number;
  /** Over a third of the points failed: stored, but retried this month. */
  degraded: boolean;
  solvPct: number | null;
  arp: number | null;
  atrp: number | null;
};

type LocalGridRunResult = {
  period: string;
  checked: LocalGridKeywordRun[];
  /** Keywords whose grid threw; retried later this month. */
  failed: { keyword: string; error: string }[];
  /** Tracker keywords already stored for the month (skipped without force). */
  alreadyCaptured: string[];
  /** Keywords not run yet: untried this month, or over the per-run limit. */
  remaining: string[];
  /** Failed or degraded this month, under the attempt cap: retried after a delay. */
  retry: string[];
  /** Failed or degraded MAX_ATTEMPTS_PER_MONTH times: left until next month. */
  gaveUp: string[];
  costUsd: number;
  /** The tracker's next scheduled run after this one (null when not scheduled). */
  nextCheckAt: string | null;
};

async function requireConfig(projectId: string): Promise<LocalGridConfig> {
  const config = await LocalGridRepository.getConfigForProject(projectId);
  if (!config) {
    throw new AppError(
      "NOT_FOUND",
      "No Maps rank grid tracker for this project. Create one first.",
    );
  }
  return config;
}

function isFinal(row: { pointsSearched: number; pointsFailed: number }) {
  return row.pointsFailed <= row.pointsSearched * MAX_FAILED_SHARE;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Grid the tracker's keywords that have no final snapshot this month (all
 * selected ones with `force`), at most `limit` (default: the call budget over
 * the grid's points). Keywords not tried yet this month go first; a keyword
 * that failed or came back degraded MAX_ATTEMPTS_PER_MONTH times waits for
 * next month. Holds the tracker's lease for the run and, for an active monthly
 * tracker, sets the next run: now while untried keywords remain, after a
 * delay while only retries remain, else the next 2nd.
 */
async function runCheck(input: {
  projectId: string;
  billingCustomer: BillingCustomerContext;
  keywords?: string[];
  force?: boolean;
  limit?: number;
  now?: Date;
}): Promise<LocalGridRunResult> {
  const config = await requireConfig(input.projectId);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const leased = await LocalGridRepository.acquireLease({
    configId: config.id,
    nowIso,
    leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
  });
  if (!leased) {
    throw new AppError(
      "RATE_LIMITED",
      "A Maps grid run for this project is already in progress. Try again in a few minutes.",
    );
  }

  let nextCheckAt = config.nextCheckAt;
  let lastError: string | null | undefined;
  let lastCheckedAt: string | undefined;
  try {
    const period = periodOf(now);
    const rows = await LocalGridRepository.listKeywords(config.id);
    const attempts = new Map(
      rows.map((r) => [r.keyword, r.attemptPeriod === period ? r.attempts : 0]),
    );
    const ids = new Map(rows.map((r) => [r.keyword, r.id]));
    const trackerKeywords = rows.map((r) => r.keyword);
    const tries = (k: string) => attempts.get(k) ?? 0;

    let selected = trackerKeywords;
    if (input.keywords?.length) {
      const wanted = new Set(cleanKeywords(input.keywords));
      selected = trackerKeywords.filter((k) => wanted.has(k));
      if (selected.length !== wanted.size) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Only tracker keywords can be run: ${trackerKeywords.join(", ")}.`,
        );
      }
    }

    const stored = await LocalGridRepository.listPeriodSnapshots(
      input.projectId,
      period,
    );
    const captured = new Set(stored.filter(isFinal).map((r) => r.keyword));
    const alreadyCaptured = input.force
      ? []
      : selected.filter((k) => captured.has(k));
    const due = input.force
      ? selected
      : sort(
          selected.filter(
            (k) => !captured.has(k) && tries(k) < MAX_ATTEMPTS_PER_MONTH,
          ),
          (a, b) => tries(a) - tries(b),
        );
    const limit = input.limit ?? keywordsPerRun(config.gridSize);
    const batch = due.slice(0, limit);
    const notRun = due.slice(limit);

    const target = {
      placeId: config.targetPlaceId ?? undefined,
      cid: config.targetCid ?? undefined,
    };
    const checked: LocalGridKeywordRun[] = [];
    const failed: { keyword: string; error: string }[] = [];
    const countAttempt = async (keyword: string) => {
      attempts.set(keyword, tries(keyword) + 1);
      const id = ids.get(keyword);
      if (id) await LocalGridRepository.recordAttempt(id, period);
    };

    for (const keyword of batch) {
      let costUsd = 0;
      const client = createDataforseoClient(input.billingCustomer, {
        onCost: (usd) => (costUsd += usd),
      });
      let result: Awaited<ReturnType<typeof runRankGrid>>;
      try {
        result = await runRankGrid({
          client,
          keyword,
          target,
          center: {
            latitude: config.centerLatitude,
            longitude: config.centerLongitude,
          },
          gridSize: config.gridSize,
          spacingKm: config.spacingKm,
          device: config.device,
          languageCode: config.languageCode,
        });
      } catch (error) {
        if (error instanceof AppError && ABORT_ERROR_CODES.has(error.code))
          throw error;
        failed.push({ keyword, error: errorText(error) });
        await countAttempt(keyword);
        continue;
      }
      const { summary, matchedBusiness } = result;
      const run = {
        pointsSearched: summary.pointsSearched,
        pointsFailed: result.grid.filter((p) => p.error).length,
      };
      await LocalGridRepository.saveSnapshot(
        {
          projectId: input.projectId,
          keyword,
          period,
          centerLatitude: config.centerLatitude,
          centerLongitude: config.centerLongitude,
          gridSize: config.gridSize,
          spacingKm: config.spacingKm,
          zoom: result.zoom,
          device: config.device,
          ...run,
          pointsFound: summary.pointsFound,
          top3Count: summary.top3Count,
          top10Count: summary.top10Count,
          solvPct: summary.solvPct,
          arp: summary.averageRank,
          atrp: summary.atrp,
          matchedTitle: matchedBusiness?.title ?? null,
          matchedPlaceId: matchedBusiness?.placeId ?? null,
          matchedCid: matchedBusiness?.cid ?? null,
          billingCostUsd: costUsd,
          capturedAt: nowIso,
        },
        result.grid.map((point) => ({
          row: point.row,
          col: point.col,
          latitude: point.latitude,
          longitude: point.longitude,
          rank: point.rank,
          resultsCount: point.resultsCount ?? null,
          competitorTitle: point.topCompetitor?.title ?? null,
          competitorCid: point.topCompetitor?.cid ?? null,
          competitorRank: point.topCompetitor?.rank ?? null,
          error: point.error ?? false,
        })),
      );
      const degraded = !isFinal(run);
      if (degraded) await countAttempt(keyword);
      else captured.add(keyword);
      checked.push({
        keyword,
        costUsd,
        ...run,
        degraded,
        pointsFound: summary.pointsFound,
        solvPct: summary.solvPct,
        arp: summary.averageRank,
        atrp: summary.atrp,
      });
    }

    const pending = selected.filter((k) => !captured.has(k));
    const untried = pending.filter((k) => tries(k) === 0);
    // A forced run past its limit also leaves already-captured keywords.
    const remaining = [
      ...new Set([...untried, ...(input.force ? notRun : [])]),
    ];
    const retry = pending.filter(
      (k) => tries(k) > 0 && tries(k) < MAX_ATTEMPTS_PER_MONTH,
    );
    const gaveUp = pending.filter((k) => tries(k) >= MAX_ATTEMPTS_PER_MONTH);

    if (checked.length > 0) lastCheckedAt = nowIso;
    if (failed.length > 0) {
      lastError = failed.map((f) => `${f.keyword}: ${f.error}`).join("; ");
    } else if (checked.length > 0) {
      lastError = null;
    }
    if (config.isActive && config.scheduleInterval === "monthly") {
      nextCheckAt =
        untried.length > 0
          ? nowIso
          : retry.length > 0
            ? new Date(now.getTime() + RETRY_DELAY_MS).toISOString()
            : nextGridCheckAt(now);
    }
    return {
      period,
      checked,
      failed,
      alreadyCaptured,
      remaining,
      retry,
      gaveUp,
      costUsd: checked.reduce((sum, run) => sum + run.costUsd, 0),
      nextCheckAt,
    };
  } finally {
    await LocalGridRepository.updateConfig(config.id, {
      leaseUntil: null,
      nextCheckAt,
      ...(lastCheckedAt ? { lastCheckedAt } : {}),
      ...(lastError === undefined ? {} : { lastError }),
    });
  }
}

export const LocalGridService = {
  createTracker,
  runCheck,
  getLatest,
};
