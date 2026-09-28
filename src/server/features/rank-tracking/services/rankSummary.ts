import type { RankTrackingRow } from "@/types/schemas/rank-tracking";

export type RankSummary = {
  trackedKeywords: number;
  improved: number;
  declined: number;
  top10: number;
  lastCheckedAt: string | null;
};

type RankResults = {
  rows: RankTrackingRow[];
  run: { lastCheckedAt: string | null } | null;
};

/** Roll the latest rank-check results (one entry per tracking config) into
 *  headline counts. Lower position number = better ranking. */
export function summarizeRankResults(results: RankResults[]): RankSummary {
  const summary: RankSummary = {
    trackedKeywords: 0,
    improved: 0,
    declined: 0,
    top10: 0,
    lastCheckedAt: null,
  };

  for (const result of results) {
    summary.trackedKeywords += result.rows.length;
    if (
      result.run?.lastCheckedAt &&
      (!summary.lastCheckedAt ||
        result.run.lastCheckedAt > summary.lastCheckedAt)
    ) {
      summary.lastCheckedAt = result.run.lastCheckedAt;
    }
    for (const row of result.rows) {
      for (const device of ["desktop", "mobile"] as const) {
        const { position, previousPosition } = row[device];
        if (position !== null && position <= 10) summary.top10 += 1;
        if (position === null || previousPosition === null) continue;
        if (position < previousPosition) summary.improved += 1;
        else if (position > previousPosition) summary.declined += 1;
      }
    }
  }

  return summary;
}
