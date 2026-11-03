import { AiVisibilityPromptRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityPromptRepository";
import {
  AiVisibilityPromptService,
  MAX_ATTEMPTS_PER_PERIOD,
  nextMonthlyRunAt,
  RETRY_DELAY_MS,
} from "@/server/features/ai-visibility/services/AiVisibilityPromptService";

// Two prompts per tick = up to 6 concurrent DataForSEO calls. Workers Free
// caps a cron invocation at 50 subrequests and 6 open connections; eight
// prompts drain in four */5 ticks. ChatGPT live answers can take ~100 s.
const PROMPTS_PER_TICK = 2;

/**
 * PAI-255 cron body: run buyer prompts that are due. Called from
 * runScheduledAiVisibilityChecks only on ticks where no mentions tracker was
 * due, so the two phases never share a tick's budget. Never throws.
 */
export async function runScheduledPromptChecks(now = new Date()) {
  try {
    const due =
      await AiVisibilityPromptRepository.getDuePromptsWithOrganization(
        now.toISOString(),
        PROMPTS_PER_TICK,
      );
    if (due.length === 0) return;

    const outcomes = await Promise.all(
      due.map(async ({ prompt, organizationId, projectDomain }) => {
        if (!prompt.nextRunAt) return "skipped" as const;
        const claimed = await AiVisibilityPromptRepository.claimDuePrompt({
          promptId: prompt.id,
          observedNextRunAt: prompt.nextRunAt,
          nextRunAt: nextMonthlyRunAt(now),
        });
        if (!claimed) return "skipped" as const;
        try {
          const brands = await AiVisibilityPromptService.loadBrandContext(
            prompt.projectId,
            projectDomain,
          );
          const outcome = await AiVisibilityPromptService.runPrompt({
            prompt,
            brands,
            billingCustomer: {
              userId: "system",
              userEmail: "system@openseo.so",
              organizationId,
              projectId: prompt.projectId,
            },
            period: now.toISOString().slice(0, 7),
            now,
          });
          if (
            outcome.failed.length > 0 &&
            outcome.failedAttempts < MAX_ATTEMPTS_PER_PERIOD
          ) {
            await AiVisibilityPromptRepository.updatePrompt(prompt.id, {
              nextRunAt: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
            });
          }
          return outcome;
        } catch (err) {
          console.error(
            `[cron] buyer prompt ${prompt.id} failed for project ${prompt.projectId}:`,
            err,
          );
          await AiVisibilityPromptRepository.updatePrompt(prompt.id, {
            lastError: err instanceof Error ? err.message : String(err),
            nextRunAt: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
          });
          return "error" as const;
        }
      }),
    );

    const ran = outcomes.filter((o) => typeof o === "object");
    const errors =
      outcomes.filter((o) => o === "error").length +
      ran.filter((o) => o.failed.length > 0).length;
    (errors > 0 ? console.error : console.log)({
      event: "ai_visibility_prompt_scheduler_summary",
      candidates: due.length,
      ran: ran.length,
      skipped: outcomes.filter((o) => o === "skipped").length,
      errors,
      costUsd: ran.reduce((sum, o) => sum + o.costUsd, 0),
    });
  } catch (err) {
    console.error("[cron] buyer prompt checks failed:", err);
  }
}
