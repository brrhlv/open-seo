import { LocalGridRepository } from "@/server/features/local-grid/repositories/LocalGridRepository";
import { LocalGridService } from "@/server/features/local-grid/services/LocalGridService";
import { AppError } from "@/server/lib/errors";

// One keyword is gridSize² Maps calls made inline (9 on a 3×3). Workers Free
// caps a cron invocation at 50 subrequests and the rank and AI-visibility
// loops share the tick, so each tick grids one keyword of one tracker. A
// tracker with untried keywords stays due and the next */5 tick continues it,
// so three keywords drain in ~15 minutes. runCheck holds the tracker's lease
// (shared with run_local_grid), orders untried keywords before retries, caps
// retries per month, and sets the next run.
const TRACKERS_PER_TICK = 1;
const KEYWORDS_PER_TICK = 1;

// A run that throws as a whole (credits, auth, D1) retries after this delay.
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
      (result.failed.length > 0 ? console.error : console.log)({
        event: "local_grid_scheduler_summary",
        projectId: config.projectId,
        checked: result.checked.map((run) => run.keyword),
        failed: result.failed,
        remaining: result.remaining.length,
        retry: result.retry.length,
        gaveUp: result.gaveUp,
        costUsd: result.costUsd,
        nextCheckAt: result.nextCheckAt,
      });
    } catch (err) {
      // Another run (an MCP call) holds the tracker; the next tick retries.
      if (err instanceof AppError && err.code === "RATE_LIMITED") continue;
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
