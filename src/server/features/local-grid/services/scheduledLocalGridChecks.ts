import { LocalGridRepository } from "@/server/features/local-grid/repositories/LocalGridRepository";
import {
  LocalGridService,
  nextGridCheckAt,
} from "@/server/features/local-grid/services/LocalGridService";

// One keyword is gridSize² Maps calls made inline (9 on a 3×3). Workers Free
// caps a cron invocation at 50 subrequests and the rank and AI-visibility
// loops share the tick, so each tick grids one keyword of one tracker. A
// tracker with keywords left stays due and the next */5 tick continues it, so
// three keywords drain in ~15 minutes.
const TRACKERS_PER_TICK = 1;
const KEYWORDS_PER_TICK = 1;

// A claimed tracker is hidden from other ticks for this long while it runs.
const LEASE_MS = 10 * 60_000;
// A failed run retries after this delay instead of waiting a month.
const RETRY_DELAY_MS = 6 * 60 * 60_000;

/**
 * Cron body: grid the next due keyword of a monthly tracker (CLIENT-SBLV-191).
 * Runs beside the rank and AI-visibility loops on the `*\/5` trigger.
 */
export async function runScheduledLocalGridChecks(now = new Date()) {
  const due = await LocalGridRepository.getDueConfigsWithOrganization(
    now.toISOString(),
    TRACKERS_PER_TICK,
  );

  for (const config of due) {
    // Unreachable: the due query filters on next_check_at <= now.
    if (!config.nextCheckAt) continue;

    const claimed = await LocalGridRepository.claimDueConfig({
      configId: config.id,
      observedNextCheckAt: config.nextCheckAt,
      nextCheckAt: new Date(now.getTime() + LEASE_MS).toISOString(),
    });
    if (!claimed) continue;

    try {
      const result = await LocalGridService.runCheck({
        projectId: config.projectId,
        billingCustomer: {
          userId: "system",
          userEmail: "system@openseo.so",
          organizationId: config.organizationId,
          projectId: config.projectId,
        },
        limit: KEYWORDS_PER_TICK,
        now,
      });
      // More keywords due this month: due again on the next tick.
      await LocalGridRepository.updateConfig(config.id, {
        nextCheckAt:
          result.remaining.length > 0
            ? now.toISOString()
            : nextGridCheckAt(now),
      });
      console.log({
        event: "local_grid_scheduler_summary",
        projectId: config.projectId,
        checked: result.checked.map((run) => run.keyword),
        remaining: result.remaining.length,
        costUsd: result.costUsd,
      });
    } catch (err) {
      console.error(
        `[cron] Local grid check failed for project ${config.projectId}:`,
        err,
      );
      await LocalGridRepository.updateConfig(config.id, {
        lastError: err instanceof Error ? err.message : String(err),
        nextCheckAt: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
      }).catch((writeErr: unknown) => {
        console.error(
          `[cron] Could not record local grid failure for ${config.id}:`,
          writeErr,
        );
      });
    }
  }
}
