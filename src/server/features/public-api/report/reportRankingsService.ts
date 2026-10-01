import { sortBy } from "remeda";
import {
  endOfDayCutoff,
  toIsoTimestamp,
} from "@/server/features/public-api/timestamps";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { getLatestCompletedFullRunAtOrBefore } from "@/server/features/rank-tracking/repositories/snapshotQueries";
import { ReportApiError } from "./reportErrors";
import {
  readDateParam,
  requireDateParam,
  type ReportContext,
} from "./reportRequest";

type RankConfig = Awaited<
  ReturnType<typeof RankTrackingRepository.getConfigsForProject>
>[number];

/** ISO strings order lexicographically; null when none. */
function latestIso(values: Array<string | null>): string | null {
  return values.reduce<string | null>(
    (max, value) =>
      value !== null && (max === null || value > max) ? value : max,
    null,
  );
}

async function loadConfig(
  config: RankConfig,
  asOf: string,
  compareTo: string | null,
) {
  const [asOfRun, compareRun] = await Promise.all([
    getLatestCompletedFullRunAtOrBefore(config.id, endOfDayCutoff(asOf)),
    compareTo
      ? getLatestCompletedFullRunAtOrBefore(
          config.id,
          endOfDayCutoff(compareTo),
        )
      : null,
  ]);
  const summary = {
    id: config.id,
    domain: config.domain,
    locationCode: config.locationCode,
    locationName: config.locationName,
    devices: config.devices,
    serpDepth: config.serpDepth,
    asOfRunAt: toIsoTimestamp(asOfRun?.completedAt),
    compareToRunAt: toIsoTimestamp(compareRun?.completedAt),
  };
  if (!asOfRun) return { summary, keywords: [] };

  const [current, previous, tracked] = await Promise.all([
    RankTrackingRepository.getSnapshotsForRun(asOfRun.id),
    compareRun ? RankTrackingRepository.getSnapshotsForRun(compareRun.id) : [],
    RankTrackingRepository.getKeywordsForConfig(config.id),
  ]);
  const volumeById = new Map(
    tracked.map((keyword) => [keyword.id, keyword.searchVolume]),
  );
  const key = (id: string, device: string) => `${id}\u0000${device}`;
  const previousByKey = new Map(
    previous.map((row) => [key(row.trackingKeywordId, row.device), row]),
  );

  // Rows = what the as-of run checked. position null = checked, not found
  // within serpDepth. previousChecked distinguishes "checked in the compare
  // run, not found" (previousPosition null, true) from "not checked then"
  // (false) — consumer request, 2026-10-01.
  const keywords = current.map((row) => {
    const prior = previousByKey.get(key(row.trackingKeywordId, row.device));
    return {
      configId: config.id,
      keyword: row.keyword,
      device: row.device,
      searchVolume: volumeById.get(row.trackingKeywordId) ?? null,
      position: row.position,
      url: row.url,
      previousPosition: prior?.position ?? null,
      previousUrl: prior?.url ?? null,
      previousChecked: prior !== undefined,
    };
  });
  return { summary, keywords };
}

/** R6: per active tracker config, the latest completed full run at or before
 *  asOf (and compareTo), every checked keyword x device. */
async function getRankings({ project, request }: ReportContext) {
  const asOf = requireDateParam(request, "asOf");
  const compareTo = readDateParam(request, "compareTo");
  if (compareTo !== null && compareTo > asOf) {
    throw new ReportApiError(422, "invalid_request", {
      detail: "compareTo must be on or before asOf",
    });
  }
  const configs = await RankTrackingRepository.getConfigsForProject(project.id);
  if (configs.length === 0) throw new ReportApiError(409, "no_rank_tracker");

  const loaded = await Promise.all(
    configs.map((config) => loadConfig(config, asOf, compareTo)),
  );
  return {
    configs: loaded.map((entry) => entry.summary),
    asOfRunAt: latestIso(loaded.map((entry) => entry.summary.asOfRunAt)),
    compareToRunAt: latestIso(
      loaded.map((entry) => entry.summary.compareToRunAt),
    ),
    keywords: sortBy(
      loaded.flatMap((entry) => entry.keywords),
      [(row) => row.searchVolume ?? -1, "desc"],
      (row) => row.keyword,
      (row) => row.device,
    ),
  };
}

export const ReportRankingsService = { getRankings };
