import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  createDataforseoClient,
  fetchBusinessDataTaskResult,
  type BusinessTaskEndpoint,
} from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";
import { formatBusinessDataCoordinate } from "@/server/mcp/tools/local-seo-shared";
import {
  GbpWatchRepository,
  type GbpConfig,
} from "@/server/features/gbp-watch/repositories/GbpWatchRepository";
import {
  profileFromRow,
  readReviews,
  readUpdates,
  sameProfileRun,
  snapshotInsert,
} from "@/server/features/gbp-watch/gbpSnapshotCodec";
import {
  carryForwardOmitted,
  diffProfiles,
  driftFromExpected,
} from "@/server/features/gbp-watch/gbpWatchDiff";
import {
  normalizeProfile,
  normalizeQuestions,
  normalizeReviews,
  normalizeUpdates,
  parseExpected,
  type GbpExpected,
} from "@/server/features/gbp-watch/gbpWatchModel";
import {
  buildGbpWatchView,
  GBP_VIEW_SNAPSHOT_LIMIT,
  type GbpWatchView,
} from "@/server/features/gbp-watch/gbpWatchView";

/**
 * CLIENT-SBLV-193: weekly Google Business Profile watch. A run stores one
 * gbp_snapshots row (profile, newest reviews, Q&A, owner posts) and the
 * watched-field changes since the previous row. Reads never call DataForSEO.
 */

const REVIEWS_DEPTH = 10;
const UPDATES_DEPTH = 10;
const QUESTIONS_DEPTH = 20;
// Q&A needs a coordinate; 1 km around the profile's own pin.
const QUESTIONS_RADIUS_KM = 1;
// Same window as the get_business_reviews / get_business_updates tools.
const TASK_POLL_ATTEMPTS = 6;
const TASK_POLL_INTERVAL_MS = 4000;
// A manual re-run inside this window is a no-op unless forced.
const RECENT_RUN_MS = 60 * 60 * 1000;
// How many earlier rows a run reads to find the last collected lists.
const PREVIOUS_ROWS = 10;

/**
 * Measured 2026-11-03: profile $0.0054, Q&A $0.0054 (billed when empty),
 * reviews $0.0015 per 10 at high priority; owner posts estimated the same.
 * Only feeds the run tool's description; billing_cost_usd is the real figure.
 */
export const ESTIMATED_RUN_COST_USD = 0.014;

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/** The next Monday 14:00 UTC (06:00 PST / 07:00 PDT) strictly after `now`. */
export function nextWeeklyCheckAt(now: Date): string {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 14),
  );
  const daysToMonday = (8 - next.getUTCDay()) % 7;
  next.setUTCDate(next.getUTCDate() + daysToMonday);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 7);
  return next.toISOString();
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function setWatch(input: {
  projectId: string;
  cid?: string;
  placeId?: string;
  listingId?: string;
  expected?: GbpExpected;
  includeQuestions?: boolean;
  scheduleInterval?: "weekly" | "manual";
  active?: boolean;
  now?: Date;
}): Promise<GbpConfig> {
  const existing = await GbpWatchRepository.getConfigForProject(
    input.projectId,
  );
  const cid = input.cid ?? existing?.cid ?? null;
  const placeId = input.placeId ?? existing?.placeId ?? null;
  if (!cid && !placeId) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Give the profile's cid or placeId (get_local_serp_results rows carry both).",
    );
  }
  const scheduleInterval =
    input.scheduleInterval ?? existing?.scheduleInterval ?? "weekly";
  const isActive = input.active ?? existing?.isActive ?? true;
  const keepAnchor =
    existing?.scheduleInterval === "weekly" && existing.nextCheckAt;
  return GbpWatchRepository.upsertConfig({
    projectId: input.projectId,
    cid,
    placeId,
    listingId: input.listingId ?? existing?.listingId ?? null,
    expectedJson: input.expected
      ? JSON.stringify(input.expected)
      : (existing?.expectedJson ?? "{}"),
    includeQuestions:
      input.includeQuestions ?? existing?.includeQuestions ?? true,
    scheduleInterval,
    isActive,
    nextCheckAt:
      scheduleInterval === "weekly"
        ? keepAnchor || nextWeeklyCheckAt(input.now ?? new Date())
        : null,
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

type GbpRunResult = {
  status: "checked" | "already_captured";
  capturedAt: string;
  costUsd: number;
  changes: number;
  drift: number;
  collected: { reviews: boolean; questions: boolean; updates: boolean };
};

type Market = { locationCode: number; languageCode: string };

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Post a business task and poll it; null when it fails or is still queued. */
async function collectTask(
  endpoint: BusinessTaskEndpoint,
  post: () => Promise<string>,
  pollIntervalMs: number,
): Promise<unknown[] | null> {
  try {
    const taskId = await post();
    for (let attempt = 0; attempt < TASK_POLL_ATTEMPTS; attempt++) {
      await wait(pollIntervalMs);
      const outcome = await fetchBusinessDataTaskResult({ endpoint, taskId });
      if (outcome.status === "pending") continue;
      const items: unknown = outcome.result?.items;
      const list: unknown[] = Array.isArray(items) ? items : [];
      return list;
    }
    console.warn(`[gbp-watch] ${endpoint} task ${taskId} still queued`);
    return null;
  } catch (error) {
    console.error(`[gbp-watch] ${endpoint} collection failed:`, error);
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Snapshot the project's profile now. Without `force`, a snapshot from the
 * last hour returns `already_captured` without calling DataForSEO. Only a
 * missing profile fails the run; reviews, Q&A and posts that fail or are
 * still queued are stored as "not collected" for this run.
 */
async function runSnapshot(input: {
  projectId: string;
  billingCustomer: BillingCustomerContext;
  market: Market;
  force?: boolean;
  now?: Date;
  pollIntervalMs?: number;
}): Promise<GbpRunResult> {
  const config = await GbpWatchRepository.getConfigForProject(input.projectId);
  if (!config) {
    throw new AppError(
      "NOT_FOUND",
      "No GBP watch for this project. Create one with set_gbp_watch first.",
    );
  }
  const now = input.now ?? new Date();
  const capturedAt = now.toISOString();
  const keyword = config.cid
    ? `cid:${config.cid}`
    : `place_id:${config.placeId}`;
  const latestRows = await GbpWatchRepository.listRecentSnapshots(
    input.projectId,
    PREVIOUS_ROWS,
  );
  // Only rows about this profile count as "before" (a new cid or place_id
  // starts a new baseline); the one-hour guard looks at any row.
  const history = sameProfileRun(latestRows, keyword);
  const [previous] = history;
  const [lastRun] = latestRows;
  if (
    !input.force &&
    lastRun &&
    now.getTime() - Date.parse(lastRun.capturedAt) < RECENT_RUN_MS
  ) {
    return {
      status: "already_captured",
      capturedAt: lastRun.capturedAt,
      costUsd: 0,
      changes: 0,
      drift: 0,
      collected: { reviews: false, questions: false, updates: false },
    };
  }

  let costUsd = 0;
  const client = createDataforseoClient(input.billingCustomer, {
    onCost: (usd) => (costUsd += usd),
  });
  const { locationCode, languageCode } = input.market;

  let item: Record<string, unknown> | null;
  try {
    item = await client.business.myBusinessInfo({
      keyword,
      locationCode,
      languageCode,
    });
  } catch (error) {
    await GbpWatchRepository.updateConfig(config.id, {
      lastError: errorMessage(error),
    });
    throw error;
  }
  if (!item) {
    const message = `Google returned no profile for ${keyword}`;
    await GbpWatchRepository.updateConfig(config.id, { lastError: message });
    throw new AppError("UPSTREAM_UNAVAILABLE", message);
  }
  const profile = previous
    ? carryForwardOmitted(profileFromRow(previous), normalizeProfile(item))
    : normalizeProfile(item);

  const pollMs = input.pollIntervalMs ?? TASK_POLL_INTERVAL_MS;
  const { latitude, longitude } = profile;
  const [questionRows, reviewItems, updateItems] = await Promise.all([
    config.includeQuestions && latitude !== null && longitude !== null
      ? client.business
          .questionsAnswers({
            keyword,
            locationCoordinate: formatBusinessDataCoordinate({
              latitude,
              longitude,
              radiusKm: QUESTIONS_RADIUS_KM,
            }),
            languageCode,
            depth: QUESTIONS_DEPTH,
          })
          .catch((error: unknown) => {
            console.error("[gbp-watch] Q&A failed:", error);
            return null;
          })
      : Promise.resolve(null),
    collectTask(
      "reviews",
      () =>
        client.business.reviewsTaskPost({
          cid: config.cid ?? undefined,
          placeId: config.cid ? undefined : (config.placeId ?? undefined),
          locationCode,
          languageCode,
          depth: REVIEWS_DEPTH,
          sortBy: "newest",
          includeOtherSources: false,
        }),
      pollMs,
    ),
    collectTask(
      "my_business_updates",
      () =>
        client.business.updatesTaskPost({
          keyword,
          locationCode,
          languageCode,
          depth: UPDATES_DEPTH,
        }),
      pollMs,
    ),
  ]);

  // "New" is relative to the last snapshot that collected the same list, so
  // a run that missed reviews never makes old reviews look new.
  const lastReviews = history.map(readReviews).find((list) => list !== null);
  const lastUpdates = history.map(readUpdates).find((list) => list !== null);
  const reviews = reviewItems
    ? normalizeReviews(
        reviewItems,
        lastReviews
          ? new Set(
              lastReviews.flatMap((r) => (r.reviewId ? [r.reviewId] : [])),
            )
          : null,
      )
    : null;
  const updates = updateItems
    ? normalizeUpdates(
        updateItems,
        lastUpdates ? new Set(lastUpdates.map((u) => u.key)) : null,
      )
    : null;
  const questions = questionRows ? normalizeQuestions(questionRows) : null;
  const changes = previous
    ? diffProfiles(profileFromRow(previous), profile, capturedAt)
    : [];

  await GbpWatchRepository.insertSnapshot(
    snapshotInsert({
      projectId: input.projectId,
      identifier: keyword,
      capturedAt,
      profile,
      reviews,
      questions,
      updates,
      changes,
      costUsd,
    }),
  );
  // The paid work is stored. From here nothing may throw: a caller treats a
  // throw as "nothing was saved" and may pay for a retry.
  await GbpWatchRepository.updateConfig(config.id, {
    lastCheckedAt: capturedAt,
    lastError: null,
  }).catch((error: unknown) => {
    console.error(
      `[gbp-watch] snapshot saved, but config ${config.id} was not updated:`,
      error,
    );
  });
  return {
    status: "checked",
    capturedAt,
    costUsd,
    changes: changes.length,
    drift: driftFromExpected(profile, parseExpected(config.expectedJson))
      .length,
    collected: {
      reviews: reviews !== null,
      questions: questions !== null,
      updates: updates !== null,
    },
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function getWatch(
  projectId: string,
  now = new Date(),
): Promise<GbpWatchView & { expected: GbpExpected | null }> {
  const [config, rows] = await Promise.all([
    GbpWatchRepository.getConfigForProject(projectId),
    GbpWatchRepository.listRecentSnapshots(projectId, GBP_VIEW_SNAPSHOT_LIMIT),
  ]);
  return {
    ...buildGbpWatchView(config, rows, now),
    expected: config ? parseExpected(config.expectedJson) : null,
  };
}

export const GbpWatchService = { setWatch, runSnapshot, getWatch };
