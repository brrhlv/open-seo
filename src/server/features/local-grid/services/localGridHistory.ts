import { sort } from "remeda";
import {
  LocalGridRepository,
  type LocalGridCellRow,
  type LocalGridConfig,
  type LocalGridSnapshotRow,
} from "@/server/features/local-grid/repositories/LocalGridRepository";

// CLIENT-SBLV-191: the read side of the stored grid (D1 only, never metered).
// Exposed as LocalGridService.getLatest.

// Snapshots read back per project: 10 keywords × 2 months, with headroom.
const RECENT_SNAPSHOT_LIMIT = 60;

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
export async function getLatest(projectId: string): Promise<{
  config: LocalGridConfig | null;
  trackerKeywords: string[];
  keywords: LocalGridKeywordView[];
}> {
  const [config, snapshots] = await Promise.all([
    LocalGridRepository.getConfigForProject(projectId),
    LocalGridRepository.listRecentSnapshots(projectId, RECENT_SNAPSHOT_LIMIT),
  ]);
  const trackerKeywords = config
    ? (await LocalGridRepository.listKeywords(config.id)).map((r) => r.keyword)
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
