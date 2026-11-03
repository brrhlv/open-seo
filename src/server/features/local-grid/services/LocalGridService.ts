import { sort } from "remeda";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  LocalGridRepository,
  type LocalGridCellRow,
  type LocalGridConfig,
  type LocalGridSnapshotRow,
} from "@/server/features/local-grid/repositories/LocalGridRepository";
import { runRankGrid } from "@/server/features/local-grid/services/localRankGrid";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";

/**
 * CLIENT-SBLV-191: the stored Maps rank grid. A run is one grid per keyword
 * (gridSize² Maps searches) stored as one snapshot per keyword per UTC month,
 * the business matched by place_id / cid only. Reads are D1-only.
 */

export const MAX_GRID_KEYWORDS = 10;
// MCP runs inline in one request: 3 keywords × 9 points = 27 subrequests,
// inside Workers Free's 50.
export const MAX_KEYWORDS_PER_RUN = 3;
// Maps live advanced, verified 2026-11-02 (9 calls, $0.018).
const MAPS_CALL_COST_USD = 0.002;
// Snapshots read back per project: 10 keywords × 2 months, with headroom.
const RECENT_SNAPSHOT_LIMIT = 60;

type GridDevice = "desktop" | "mobile";

/** UTC calendar month as YYYY-MM. */
function periodOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/**
 * 07:00 UTC on the 2nd: this month's when it is still ahead, else next
 * month's. The 1st belongs to the AI-visibility run (PAI-217).
 */
export function nextGridCheckAt(now: Date): string {
  const thisMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 2, 7);
  if (now.getTime() < thisMonth) return new Date(thisMonth).toISOString();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2, 7),
  ).toISOString();
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
    const keyword = raw.trim().replace(/\s+/g, " ");
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);
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
  const scheduleInterval = input.scheduleInterval ?? "monthly";
  const config = await LocalGridRepository.upsertConfig({
    projectId: input.projectId,
    targetName: input.target.name ?? null,
    targetPlaceId: input.target.placeId ?? null,
    targetCid: input.target.cid ?? null,
    centerLatitude: input.center.latitude,
    centerLongitude: input.center.longitude,
    gridSize: input.gridSize ?? 3,
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
  solvPct: number | null;
  arp: number | null;
  atrp: number | null;
};

type LocalGridRunResult = {
  period: string;
  checked: LocalGridKeywordRun[];
  /** Tracker keywords already stored for the month (skipped without force). */
  alreadyCaptured: string[];
  /** Due keywords left for a later run (over the per-run limit). */
  remaining: string[];
  costUsd: number;
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

/**
 * Grid the tracker's keywords that have no snapshot this month (all selected
 * ones with `force`), at most `limit` of them. The rest come back as
 * `remaining` for the next run.
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
  const period = periodOf(now);
  const trackerKeywords = await LocalGridRepository.listKeywords(config.id);

  let selected = trackerKeywords;
  if (input.keywords?.length) {
    const wanted = new Set(
      cleanKeywords(input.keywords).map((k) => k.toLowerCase()),
    );
    selected = trackerKeywords.filter((k) => wanted.has(k.toLowerCase()));
    if (selected.length !== wanted.size) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Only tracker keywords can be run: ${trackerKeywords.join(", ")}.`,
      );
    }
  }

  const captured = new Set(
    await LocalGridRepository.listCapturedKeywords(input.projectId, period),
  );
  const alreadyCaptured = input.force
    ? []
    : selected.filter((k) => captured.has(k));
  const due = selected.filter((k) => input.force || !captured.has(k));
  const limit = input.limit ?? MAX_KEYWORDS_PER_RUN;
  const batch = due.slice(0, limit);

  const target = {
    placeId: config.targetPlaceId ?? undefined,
    cid: config.targetCid ?? undefined,
  };
  const checked: LocalGridKeywordRun[] = [];
  for (const keyword of batch) {
    let costUsd = 0;
    const client = createDataforseoClient(input.billingCustomer, {
      onCost: (usd) => (costUsd += usd),
    });
    const result = await runRankGrid({
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
    const { summary, matchedBusiness } = result;
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
        pointsSearched: summary.pointsSearched,
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
        capturedAt: now.toISOString(),
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
    checked.push({
      keyword,
      costUsd,
      pointsFound: summary.pointsFound,
      pointsSearched: summary.pointsSearched,
      solvPct: summary.solvPct,
      arp: summary.averageRank,
      atrp: summary.atrp,
    });
  }

  if (checked.length > 0) {
    await LocalGridRepository.updateConfig(config.id, {
      lastCheckedAt: now.toISOString(),
      lastError: null,
    });
  }
  return {
    period,
    checked,
    alreadyCaptured,
    remaining: due.slice(limit),
    costUsd: checked.reduce((sum, run) => sum + run.costUsd, 0),
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export type LocalGridCellView = {
  row: number;
  col: number;
  latitude: number;
  longitude: number;
  rank: number | null;
  resultsCount: number | null;
  topCompetitor: {
    title: string | null;
    cid: string | null;
    rank: number;
  } | null;
  error: boolean;
};

type LocalGridKeywordView = {
  keyword: string;
  latest: LocalGridSnapshotRow & { cells: LocalGridCellView[] };
  previous: (LocalGridSnapshotRow & { cells: LocalGridCellView[] }) | null;
};

function cellView(row: LocalGridCellRow): LocalGridCellView {
  return {
    row: row.row,
    col: row.col,
    latitude: row.latitude,
    longitude: row.longitude,
    rank: row.rank,
    resultsCount: row.resultsCount,
    topCompetitor:
      row.competitorRank == null
        ? null
        : {
            title: row.competitorTitle,
            cid: row.competitorCid,
            rank: row.competitorRank,
          },
    error: row.error,
  };
}

/**
 * The latest and previous stored grid per keyword. Tracker keywords come
 * first in tracker order; keywords that only have history follow, A to Z.
 */
async function getLatest(projectId: string): Promise<{
  config: LocalGridConfig | null;
  trackerKeywords: string[];
  keywords: LocalGridKeywordView[];
}> {
  const [config, snapshots] = await Promise.all([
    LocalGridRepository.getConfigForProject(projectId),
    LocalGridRepository.listRecentSnapshots(projectId, RECENT_SNAPSHOT_LIMIT),
  ]);
  const trackerKeywords = config
    ? await LocalGridRepository.listKeywords(config.id)
    : [];

  // Newest period first, so the first two rows per keyword are latest/previous.
  const byKeyword = new Map<string, LocalGridSnapshotRow[]>();
  for (const row of snapshots) {
    const list = byKeyword.get(row.keyword) ?? [];
    if (list.length < 2) list.push(row);
    byKeyword.set(row.keyword, list);
  }
  const picked = [...byKeyword.values()].flat();
  const cells = await LocalGridRepository.listCells(picked.map((r) => r.id));
  const cellsOf = (id: number) =>
    cells.filter((c) => c.snapshotId === id).map(cellView);

  const order = [
    ...trackerKeywords.filter((k) => byKeyword.has(k)),
    ...sort(
      [...byKeyword.keys()].filter((k) => !trackerKeywords.includes(k)),
      (a, b) => a.localeCompare(b),
    ),
  ];
  const keywords = order.flatMap((keyword): LocalGridKeywordView[] => {
    const [latest, previous] = byKeyword.get(keyword) ?? [];
    if (!latest) return [];
    return [
      {
        keyword,
        latest: { ...latest, cells: cellsOf(latest.id) },
        previous: previous
          ? { ...previous, cells: cellsOf(previous.id) }
          : null,
      },
    ];
  });
  return { config, trackerKeywords, keywords };
}

export const LocalGridService = {
  createTracker,
  runCheck,
  getLatest,
};
