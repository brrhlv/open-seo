import { AppError } from "@/server/lib/errors";

/**
 * The Maps rank grid: one Google Maps search per point of a square grid around
 * a coordinate, and where a business ranks at each point. Shared by the
 * one-shot `get_local_rank_grid` MCP tool and the stored monthly tracker
 * (CLIENT-SBLV-191).
 */

// Degrees per kilometre. Longitude degrees shrink with latitude; the cosine is
// floored so a near-polar center can't blow the spacing up.
const KM_PER_DEGREE_LATITUDE = 110.574;
const KM_PER_DEGREE_LONGITUDE = 111.32;
const MIN_LONGITUDE_COSINE = 0.01;
export const RANK_GRID_DEPTH = 20;
const RANK_GRID_CONCURRENCY = 3;
// Without an explicit zoom DataForSEO infers one per coordinate, which yields
// "No Search Results" for some points and makes ranks incomparable across the
// grid. A fixed zoom fails the other way: a mobile viewport at zoom 14 spans
// only ~±1.5 km east-west at mid latitudes, so a business one 2-3 km grid step
// to the side falls outside the viewport and reads as "not ranked" (verified
// live: a rank-3 business vanished at zoom 14 and reappeared at zoom 12).
// Derive the zoom from the spacing instead: a world tile is 40075·cos(lat)/2^z
// km wide and a portrait viewport ~1.5 tiles, so the largest zoom whose
// viewport still spans ~1.25× the spacing is log2(24045·cos(lat)/spacing).
const RANK_GRID_ZOOM_NUMERATOR_KM = 24045;
const MIN_RANK_GRID_ZOOM = 4;
const MAX_RANK_GRID_ZOOM = 18;

// A per-point failure usually means only that point's SERP failed, but these
// codes mean every remaining call would fail (and possibly bill) the same way —
// surface them instead of rendering a misleading grid.
const GRID_ABORT_ERROR_CODES = new Set<string>([
  "INSUFFICIENT_CREDITS",
  "DATAFORSEO_AUTH_FAILED",
]);

type GridTarget = { cid?: string; placeId?: string; name?: string };

export type GridPoint = {
  row: number;
  col: number;
  latitude: number;
  longitude: number;
};

export type GridBusiness = { title: string | null; cid: string | null };

export type GridPointResult = GridPoint & {
  rank: number | null;
  // How many businesses the SERP returned there, and who ranked first: a null
  // rank with a full result set means outranked; with a near-empty one it
  // means a sparse SERP. Both absent when the point's search failed.
  resultsCount?: number;
  topResult?: GridBusiness | null;
  // The best-ranked business that is not the target.
  topCompetitor?: (GridBusiness & { rank: number }) | null;
  error?: boolean;
};

type GridSummary = {
  pointsSearched: number;
  pointsFound: number;
  /** Average rank where found (ARP). */
  averageRank: number | null;
  top3Count: number;
  top10Count: number;
  /** Share of local voice: top-3 points over points that returned a SERP, 0..100. */
  solvPct: number | null;
  /** Average total rank position: every point that returned a SERP, not found = depth + 1. */
  atrp: number | null;
};

type MatchedBusiness = {
  title: string | null;
  cid: string | null;
  placeId: string | null;
};

type LocalSerpClient = {
  serp: {
    local: (input: {
      keyword: string;
      locationCoordinate?: string;
      languageCode: string;
      searchType: "maps" | "local_finder";
      device: "desktop" | "mobile";
      depth: number;
      searchPlaces?: boolean;
    }) => Promise<Record<string, unknown>[]>;
  };
};

function field(source: unknown, key: string): unknown {
  return typeof source === "object" && source !== null
    ? Reflect.get(source, key)
    : undefined;
}

function stringField(source: unknown, key: string): string | null {
  const value = field(source, key);
  return typeof value === "string" ? value : null;
}

function itemRank(item: unknown): number | null {
  const rank = field(item, "rank_absolute") ?? field(item, "rank_group");
  return typeof rank === "number" ? rank : null;
}

const round2 = (value: number) => Number(value.toFixed(2));
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const coordinate = (value: number) => Number(value.toFixed(7)).toString();

/** "lat,lng,<zoom>z" as the Maps SERP wants (same as formatLocalSerpCoordinate). */
function gridCoordinate(point: GridPoint, zoom: number): string {
  return `${coordinate(point.latitude)},${coordinate(point.longitude)},${zoom}z`;
}

function rankGridZoom(spacingKm: number, latitude: number): number {
  const cosine = Math.max(
    Math.abs(Math.cos((latitude * Math.PI) / 180)),
    MIN_LONGITUDE_COSINE,
  );
  const zoom = Math.floor(
    Math.log2((RANK_GRID_ZOOM_NUMERATOR_KM * cosine) / spacingKm),
  );
  return Math.min(MAX_RANK_GRID_ZOOM, Math.max(MIN_RANK_GRID_ZOOM, zoom));
}

function buildRankGridPoints(
  center: { latitude: number; longitude: number },
  gridSize: number,
  spacingKm: number,
): GridPoint[] {
  const middle = (gridSize - 1) / 2;
  const latitudeStep = spacingKm / KM_PER_DEGREE_LATITUDE;
  const longitudeStep =
    spacingKm /
    (KM_PER_DEGREE_LONGITUDE *
      Math.max(
        Math.abs(Math.cos((center.latitude * Math.PI) / 180)),
        MIN_LONGITUDE_COSINE,
      ));

  const points: GridPoint[] = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      points.push({
        row,
        col,
        // Row 0 is the northernmost line so the rendered grid reads like a map.
        latitude: Number(
          (center.latitude + (middle - row) * latitudeStep).toFixed(7),
        ),
        longitude: Number(
          (center.longitude + (col - middle) * longitudeStep).toFixed(7),
        ),
      });
    }
  }
  return points;
}

/** cid or place_id first; the title only when the target gives a name. */
function isTargetItem(item: unknown, target: GridTarget): boolean {
  if (target.cid != null && field(item, "cid") === target.cid) return true;
  if (target.placeId != null && field(item, "place_id") === target.placeId)
    return true;
  const name = target.name?.toLowerCase();
  if (name == null) return false;
  const title = field(item, "title");
  return typeof title === "string" && title.toLowerCase().includes(name);
}

export function summarizeGrid(
  grid: GridPointResult[],
  depth = RANK_GRID_DEPTH,
): GridSummary {
  const ranks = grid.flatMap((point) =>
    point.rank == null ? [] : [point.rank],
  );
  const answered = grid.filter((point) => !point.error);
  const top3Count = ranks.filter((rank) => rank <= 3).length;
  return {
    pointsSearched: grid.length,
    pointsFound: ranks.length,
    averageRank: ranks.length ? round2(sum(ranks) / ranks.length) : null,
    top3Count,
    top10Count: ranks.filter((rank) => rank <= 10).length,
    solvPct: answered.length
      ? round2((top3Count / answered.length) * 100)
      : null,
    atrp: answered.length
      ? round2(
          sum(answered.map((point) => point.rank ?? depth + 1)) /
            answered.length,
        )
      : null,
  };
}

/**
 * Searches every grid point (a few at a time) and locates the target. Throws
 * on an abort-worthy failure (credits, auth) before later batches bill, and
 * when every point failed; a single failed point is kept as `error: true`.
 */
export async function runRankGrid(input: {
  client: LocalSerpClient;
  keyword: string;
  target: GridTarget;
  center: { latitude: number; longitude: number };
  gridSize: number;
  spacingKm: number;
  device: "desktop" | "mobile";
  languageCode: string;
  zoom?: number;
}): Promise<{
  grid: GridPointResult[];
  summary: GridSummary;
  matchedBusiness: MatchedBusiness | null;
  zoom: number;
}> {
  const zoom =
    input.zoom ?? rankGridZoom(input.spacingKm, input.center.latitude);
  const points = buildRankGridPoints(
    input.center,
    input.gridSize,
    input.spacingKm,
  );

  let matchedBusiness: MatchedBusiness | null = null;
  let lastError: unknown = null;

  const searchPoint = async (point: GridPoint): Promise<GridPointResult> => {
    try {
      const items = await input.client.serp.local({
        keyword: input.keyword,
        locationCoordinate: gridCoordinate(point, zoom),
        languageCode: input.languageCode,
        searchType: "maps",
        device: input.device,
        depth: RANK_GRID_DEPTH,
        searchPlaces: false,
      });
      const match = items.find((item) => isTargetItem(item, input.target));
      if (match && !matchedBusiness) {
        matchedBusiness = {
          title: stringField(match, "title"),
          cid: stringField(match, "cid"),
          placeId: stringField(match, "place_id"),
        };
      }
      const first = items[0];
      const competitor = items.find(
        (item) => item !== match && itemRank(item) != null,
      );
      return {
        ...point,
        rank: match ? itemRank(match) : null,
        resultsCount: items.length,
        topResult:
          first == null
            ? null
            : {
                title: stringField(first, "title"),
                cid: stringField(first, "cid"),
              },
        topCompetitor:
          competitor == null
            ? null
            : {
                title: stringField(competitor, "title"),
                cid: stringField(competitor, "cid"),
                rank: itemRank(competitor) ?? 0,
              },
      };
    } catch (error) {
      if (error instanceof AppError && GRID_ABORT_ERROR_CODES.has(error.code))
        throw error;
      lastError = error;
      return { ...point, rank: null, error: true };
    }
  };

  // A few points at a time; an abort-worthy failure rejects its batch and
  // stops later batches from dispatching (and billing).
  const grid: GridPointResult[] = [];
  for (let i = 0; i < points.length; i += RANK_GRID_CONCURRENCY) {
    const batch = points.slice(i, i + RANK_GRID_CONCURRENCY);
    grid.push(...(await Promise.all(batch.map(searchPoint))));
  }

  // Every point failing means a systemic failure (auth, balance, bad market),
  // not a business that simply doesn't rank — surface it instead of an empty grid.
  if (grid.every((point) => point.error)) throw lastError;

  return { grid, summary: summarizeGrid(grid), matchedBusiness, zoom };
}
