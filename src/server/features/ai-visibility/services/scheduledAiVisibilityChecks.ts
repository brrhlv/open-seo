import { AiVisibilityRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import {
  AiVisibilityService,
  nextMonthlyCheckAt,
} from "@/server/features/ai-visibility/services/AiVisibilityService";

// A run is ~8 sequential DataForSEO calls made inline (no Workflow), so keep
// each tick small: Workers Free caps a cron invocation at 50 subrequests, and
// the rank-check loop shares the same tick. Unprocessed configs stay due and
// the next */5 tick picks them up, so nine projects drain in ~25 minutes.
const AI_VISIBILITY_CHECKS_PER_TICK = 2;

// Same wall-clock guard as runScheduledRankChecks.
const TICK_DEADLINE_MS = 3 * 60_000;

// A failed run retries after this delay instead of waiting a month.
const RETRY_DELAY_MS = 6 * 60 * 60_000;

/**
 * Cron body: snapshot AI visibility for every monthly tracker that is due.
 * Runs beside runScheduledRankChecks on the `*\/5` trigger. Self-hosted only
 * in practice; hosted mode is metered by getBrandLookup like any lookup.
 */
export async function runScheduledAiVisibilityChecks(now = new Date()) {
  const deadline = Date.now() + TICK_DEADLINE_MS;
  const due = await AiVisibilityRepository.getDueConfigsWithOrganization(
    now.toISOString(),
    AI_VISIBILITY_CHECKS_PER_TICK,
  );

  let checked = 0;
  let alreadyCaptured = 0;
  let concurrentChangeSkips = 0;
  let errors = 0;
  let stoppedByDeadline = false;
  let costUsd = 0;

  for (const config of due) {
    if (Date.now() >= deadline) {
      stoppedByDeadline = true;
      break;
    }
    // Unreachable: the due query filters on next_check_at <= now.
    if (!config.nextCheckAt) continue;

    const claimed = await AiVisibilityRepository.claimDueConfig({
      configId: config.id,
      observedNextCheckAt: config.nextCheckAt,
      nextCheckAt: nextMonthlyCheckAt(now),
    });
    if (!claimed) {
      concurrentChangeSkips++;
      continue;
    }

    try {
      const result = await AiVisibilityService.runCheck({
        projectId: config.projectId,
        billingCustomer: {
          userId: "system",
          userEmail: "system@openseo.so",
          organizationId: config.organizationId,
          projectId: config.projectId,
        },
        now,
      });
      if (result.status === "checked") checked++;
      else alreadyCaptured++;
      costUsd += result.costUsd;
    } catch (err) {
      errors++;
      console.error(
        `[cron] AI visibility check failed for project ${config.projectId}:`,
        err,
      );
      await AiVisibilityRepository.updateConfig(config.id, {
        lastError: err instanceof Error ? err.message : String(err),
        nextCheckAt: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
      }).catch((writeErr: unknown) => {
        console.error(
          `[cron] Could not record AI visibility failure for ${config.id}:`,
          writeErr,
        );
      });
    }
  }

  if (due.length === 0) return;
  (errors > 0 ? console.error : console.log)({
    event: "ai_visibility_scheduler_summary",
    candidates: due.length,
    checked,
    alreadyCaptured,
    concurrentChangeSkips,
    errors,
    stoppedByDeadline,
    costUsd,
  });
}
