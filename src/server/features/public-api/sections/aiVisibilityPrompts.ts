import { AiVisibilityPromptService } from "@/server/features/ai-visibility/services/AiVisibilityPromptService";
import { toIsoTimestamp } from "../timestamps";

/**
 * PAI-255: `aiVisibility.prompts` in the public summary. Stored buyer-prompt
 * results only (no DataForSEO call): per active prompt, the latest run per
 * platform and the run before it. Never throws; a failure becomes
 * `{ error }` for this key alone so the rest of `aiVisibility` still renders.
 */
export async function getAiVisibilityPromptsSection(projectId: string) {
  try {
    const { schedule, lastRunAt, nextRunAt, items } =
      await AiVisibilityPromptService.getResults(projectId);
    return {
      schedule,
      lastRunAt: toIsoTimestamp(lastRunAt),
      nextRunAt: toIsoTimestamp(nextRunAt),
      items: items.map((item) => ({
        id: item.id,
        prompt: item.prompt,
        platforms: item.platforms,
        createdAt: toIsoTimestamp(item.createdAt),
        results: item.results.map(({ platform, latest, previous }) => ({
          platform,
          latest: { ...latest, capturedAt: toIsoTimestamp(latest.capturedAt) },
          previous: previous
            ? { ...previous, capturedAt: toIsoTimestamp(previous.capturedAt) }
            : null,
        })),
      })),
    };
  } catch (error) {
    console.error(
      "public-summary: aiVisibility.prompts section failed",
      { projectId },
      error,
    );
    return { error: "internal_error" };
  }
}
