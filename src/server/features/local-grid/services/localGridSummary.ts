import { toIsoTimestamp } from "@/server/features/public-api/timestamps";
import {
  LocalGridService,
  type LocalGridCellView,
} from "@/server/features/local-grid/services/LocalGridService";

/**
 * CLIENT-SBLV-191: the stored grid as the public summary's `localGrid`
 * section and the get_local_grid tool's structured result. D1 only.
 */

type Figures = {
  solvPct: number | null;
  arp: number | null;
  atrp: number | null;
  pointsFound: number;
};

const diff = (a: number | null, b: number | null) =>
  a == null || b == null ? null : Number((a - b).toFixed(2));

export type LocalGridKeywordSummary = Figures & {
  keyword: string;
  period: string;
  capturedAt: string | null;
  gridSize: number;
  spacingKm: number;
  zoom: number;
  device: "desktop" | "mobile";
  pointsSearched: number;
  top3Count: number;
  top10Count: number;
  cells: LocalGridCellView[];
  previous:
    | (Figures & {
        period: string;
        capturedAt: string | null;
        cells: { row: number; col: number; rank: number | null }[];
      })
    | null;
  /** Latest minus previous; lower arp / atrp is better. */
  delta: {
    solvPct: number | null;
    arp: number | null;
    atrp: number | null;
    pointsFound: number;
  } | null;
};

type LocalGridSummary = {
  tracked: boolean;
  target: {
    name: string | null;
    placeId: string | null;
    cid: string | null;
  } | null;
  center: { latitude: number; longitude: number } | null;
  gridSize: number | null;
  spacingKm: number | null;
  scheduleInterval: "monthly" | "manual" | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  keywords: LocalGridKeywordSummary[];
};

export async function getLocalGridSummary(
  projectId: string,
): Promise<LocalGridSummary> {
  const { config, keywords } = await LocalGridService.getLatest(projectId);
  return {
    tracked: config?.isActive ?? false,
    target: config
      ? {
          name: config.targetName,
          placeId: config.targetPlaceId,
          cid: config.targetCid,
        }
      : null,
    center: config
      ? { latitude: config.centerLatitude, longitude: config.centerLongitude }
      : null,
    gridSize: config?.gridSize ?? null,
    spacingKm: config?.spacingKm ?? null,
    scheduleInterval: config?.scheduleInterval ?? null,
    lastCheckedAt: toIsoTimestamp(config?.lastCheckedAt),
    nextCheckAt: toIsoTimestamp(config?.nextCheckAt),
    keywords: keywords.map(({ keyword, latest, previous }) => ({
      keyword,
      period: latest.period,
      capturedAt: toIsoTimestamp(latest.capturedAt),
      gridSize: latest.gridSize,
      spacingKm: latest.spacingKm,
      zoom: latest.zoom,
      device: latest.device,
      pointsSearched: latest.pointsSearched,
      pointsFound: latest.pointsFound,
      top3Count: latest.top3Count,
      top10Count: latest.top10Count,
      solvPct: latest.solvPct,
      arp: latest.arp,
      atrp: latest.atrp,
      cells: latest.cells,
      previous: previous
        ? {
            period: previous.period,
            capturedAt: toIsoTimestamp(previous.capturedAt),
            solvPct: previous.solvPct,
            arp: previous.arp,
            atrp: previous.atrp,
            pointsFound: previous.pointsFound,
            cells: previous.cells.map(({ row, col, rank }) => ({
              row,
              col,
              rank,
            })),
          }
        : null,
      delta: previous
        ? {
            solvPct: diff(latest.solvPct, previous.solvPct),
            arp: diff(latest.arp, previous.arp),
            atrp: diff(latest.atrp, previous.atrp),
            pointsFound: latest.pointsFound - previous.pointsFound,
          }
        : null,
    })),
  };
}
