import { z } from "zod";
import { AiVisibilityPromptService } from "@/server/features/ai-visibility/services/AiVisibilityPromptService";
import type { PromptPlatformResultView } from "@/server/features/ai-visibility/services/aiVisibilityPromptResults";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const inputSchema = { projectId: projectIdSchema } as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const PLATFORM_LABELS = {
  chat_gpt: "ChatGPT",
  google_ai_mode: "Google AI Mode",
  perplexity: "Perplexity",
} as const;

function describeRun(run: {
  status: string;
  mentioned: boolean | null;
  position: number | null;
  brandsNamed: number | null;
}): string {
  if (run.status === "error") return "check failed";
  if (!run.mentioned) return "not mentioned";
  if (!run.position) return "mentioned";
  return `#${run.position}${run.brandsNamed ? ` of ${run.brandsNamed}` : ""}`;
}

/** "ChatGPT 2026-11: #1 of 5, cited https://…/corporate-events (first run)". */
function describePromptResult(result: PromptPlatformResultView): string {
  const { latest, previous } = result;
  const cited = latest.citedUrl ? `, cited ${latest.citedUrl}` : "";
  const rivals =
    latest.competitors.length > 0
      ? `, competitors ${latest.competitors.map((c) => `${c.name ?? c.domain} #${c.position}`).join(", ")}`
      : "";
  const was = previous
    ? ` (was ${describeRun(previous)} in ${previous.period})`
    : " (first run)";
  return `${PLATFORM_LABELS[result.platform]} ${latest.period}: ${describeRun(latest)}${cited}${rivals}${was}`;
}

export const getAiVisibilityPromptResultsTool = {
  name: "get_ai_visibility_prompt_results",
  config: {
    title: "Get AI visibility buyer prompt results",
    description:
      "Read-only: for each tracked buyer prompt, the latest stored answer per platform (ChatGPT, Google AI Mode, Perplexity) and the run before it: whether the brand was named, its position among the brands named, the cited page, the tracked competitors named and a short excerpt. Uses no credits and makes no DataForSEO call. Competitors are matched by domain or by the name stored in project context, so a competitor the AI calls by another name may be missed.",
    inputSchema,
    outputSchema: z
      .object({
        lastRunAt: z.string().nullable(),
        nextRunAt: z.string().nullable(),
        items: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const result = await AiVisibilityPromptService.getResults(args.projectId);
    const body = result.items.map((item) => {
      const lines =
        item.results.length === 0
          ? ["  - not run yet"]
          : item.results.map((r) => `  - ${describePromptResult(r)}`);
      return `"${item.prompt}"\n${lines.join("\n")}`;
    });
    return mcpResponse({
      text:
        result.items.length === 0
          ? "No buyer prompts are tracked for this project. Add some with add_ai_visibility_prompts."
          : `${body.join("\n")}\nLast run ${result.lastRunAt ?? "never"}; next ${result.nextRunAt ?? "not scheduled"}. No credits were used.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/brand-lookup`,
      ),
      structuredContent: { ...result },
    });
  }),
};
