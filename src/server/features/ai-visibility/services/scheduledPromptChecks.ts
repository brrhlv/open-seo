import { AiVisibilityPromptRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityPromptRepository";
import { AiVisibilityPromptService } from "@/server/features/ai-visibility/services/AiVisibilityPromptService";
import {
  PROMPT_CONCURRENCY,
  RETRY_DELAY_MS,
  runPromptsGuarded,
} from "@/server/features/ai-visibility/services/promptRuns";

// One batch per tick: two prompts = up to 6 DataForSEO calls, within Workers
// Free's 6 connections and 50 subrequests. Eight prompts drain in four */5
// ticks. ChatGPT answers can take ~100 s (its own 150 s budget).
const PROMPTS_PER_TICK = PROMPT_CONCURRENCY;

/**
 * The phase starts only when the tick has used less than this. The rank loop
 * runs first and its calls share the tick's subrequest budget, which a Worker
 * can't read; elapsed time is the available proxy for a heavy tick. Due
 * prompts simply wait for the next tick.
 */
const PROMPT_PHASE_MAX_TICK_ELAPSED_MS = 60_000;

type DueRow = Awaited<
  ReturnType<typeof AiVisibilityPromptRepository.getDuePromptsWithOrganization>
>[number];

/**
 * PAI-255 cron body: run buyer prompts that are due, through the same guards
 * as "run now" (lease, 3 attempts per platform per month, 10 prompts per
 * project per month, spend cap). Called from runScheduledAiVisibilityChecks
 * only on ticks where no mentions tracker was due. Never throws.
 */
export async function runScheduledPromptChecks(
  now = new Date(),
  tickStartedAtMs = Date.now(),
) {
  try {
    const elapsed = Date.now() - tickStartedAtMs;
    if (elapsed > PROMPT_PHASE_MAX_TICK_ELAPSED_MS) {
      console.log({
        event: "ai_visibility_prompt_phase_deferred",
        elapsedMs: elapsed,
      });
      return;
    }
    const due =
      await AiVisibilityPromptRepository.getDuePromptsWithOrganization(
        now.toISOString(),
        PROMPTS_PER_TICK,
      );
    if (due.length === 0) return;

    const byProject = new Map<string, DueRow[]>();
    for (const row of due) {
      const list = byProject.get(row.prompt.projectId) ?? [];
      list.push(row);
      byProject.set(row.prompt.projectId, list);
    }
    let ran = 0;
    let skipped = 0;
    let errors = 0;
    let costUsd = 0;
    for (const [projectId, rows] of byProject) {
      const first = rows[0];
      if (!first) continue;
      try {
        const brands = await AiVisibilityPromptService.loadBrandContext(
          projectId,
          first.projectDomain,
        );
        const result = await runPromptsGuarded({
          projectId,
          prompts: rows.map((row) => row.prompt),
          brands,
          billingCustomer: {
            userId: "system",
            userEmail: "system@openseo.so",
            organizationId: first.organizationId,
            projectId,
          },
          now,
        });
        ran += result.outcomes.length;
        skipped += result.skipped.length;
        errors += result.outcomes.filter((o) => o.failed.length > 0).length;
        costUsd += result.costUsd;
      } catch (err) {
        // The brand context failed to load, so nothing was claimed or spent:
        // back off 6 h instead of retrying every tick.
        errors += rows.length;
        console.error(`[cron] buyer prompts failed for ${projectId}:`, err);
        for (const { prompt } of rows) {
          await AiVisibilityPromptRepository.updatePrompt(prompt.id, {
            lastError: err instanceof Error ? err.message : String(err),
            nextRunAt: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
          });
        }
      }
    }
    (errors > 0 ? console.error : console.log)({
      event: "ai_visibility_prompt_scheduler_summary",
      candidates: due.length,
      ran,
      skipped,
      errors,
      costUsd,
    });
  } catch (err) {
    console.error("[cron] buyer prompt checks failed:", err);
  }
}
