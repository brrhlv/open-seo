import { GbpWatchRepository } from "@/server/features/gbp-watch/repositories/GbpWatchRepository";
import {
  GbpWatchService,
  nextWeeklyCheckAt,
} from "@/server/features/gbp-watch/services/GbpWatchService";

// A run is 4 DataForSEO calls plus up to 12 task polls made inline, so one
// watch per tick keeps the shared */5 invocation well under Workers Free's
// 50-subrequest cap. Unprocessed watches stay due for the next tick.
const GBP_SNAPSHOTS_PER_TICK = 1;

// A failed run retries after this delay instead of waiting a week.
const RETRY_DELAY_MS = 6 * 60 * 60_000;

/**
 * Cron body (CLIENT-SBLV-193): snapshot every weekly GBP watch that is due.
 * Runs after the AI-visibility loop on the `*\/5` trigger.
 */
export async function runScheduledGbpSnapshots(now = new Date()) {
  const due = await GbpWatchRepository.getDueConfigs(
    now.toISOString(),
    GBP_SNAPSHOTS_PER_TICK,
  );

  let checked = 0;
  let concurrentChangeSkips = 0;
  let errors = 0;
  let costUsd = 0;

  for (const config of due) {
    // Unreachable: the due query filters on next_check_at <= now.
    if (!config.nextCheckAt) continue;
    const claimed = await GbpWatchRepository.claimDueConfig({
      configId: config.id,
      observedNextCheckAt: config.nextCheckAt,
      nextCheckAt: nextWeeklyCheckAt(now),
    });
    if (!claimed) {
      concurrentChangeSkips++;
      continue;
    }

    try {
      const result = await GbpWatchService.runSnapshot({
        projectId: config.projectId,
        billingCustomer: {
          userId: "system",
          userEmail: "system@openseo.so",
          organizationId: config.organizationId,
          projectId: config.projectId,
        },
        market: {
          locationCode: config.locationCode,
          languageCode: config.languageCode,
        },
        // The weekly slot is the schedule; the one-hour guard is for manual runs.
        force: true,
        now,
      });
      checked++;
      costUsd += result.costUsd;
    } catch (err) {
      errors++;
      console.error(
        `[cron] GBP snapshot failed for project ${config.projectId}:`,
        err,
      );
      await GbpWatchRepository.updateConfig(config.id, {
        nextCheckAt: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
      }).catch((writeErr: unknown) => {
        console.error(
          `[cron] Could not reschedule GBP watch ${config.id}:`,
          writeErr,
        );
      });
    }
  }

  if (due.length === 0) return;
  (errors > 0 ? console.error : console.log)({
    event: "gbp_snapshot_scheduler_summary",
    candidates: due.length,
    checked,
    concurrentChangeSkips,
    errors,
    costUsd,
  });
}
