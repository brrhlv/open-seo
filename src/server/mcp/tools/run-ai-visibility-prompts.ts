import { z } from "zod";
import {
  AiVisibilityPromptService,
  ESTIMATED_PROMPT_RUN_COST_USD,
  MAX_ACTIVE_PROMPTS,
  MONTHLY_PROMPT_COST_CAP_USD,
} from "@/server/features/ai-visibility/services/AiVisibilityPromptService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const inputSchema = {
  projectId: projectIdSchema,
  promptIds: z
    .array(z.string().uuid())
    .min(1)
    .max(MAX_ACTIVE_PROMPTS)
    .optional()
    .describe("Prompts to run. Defaults to every active prompt."),
  force: z
    .boolean()
    .optional()
    .describe(
      "Ask again even on platforms that already have an answer this month (spends credits again).",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const runAiVisibilityPromptsTool = {
  name: "run_ai_visibility_prompts",
  config: {
    title: "Run AI visibility buyer prompts",
    description: `Ask the project's buyer prompts now on ChatGPT, Google AI Mode and Perplexity (DataForSEO live endpoints) and store this month's answers. This spends credits: about $${ESTIMATED_PROMPT_RUN_COST_USD.toFixed(3)} per prompt for all three platforms. Show the user the estimate before calling. Platforms that already have an answer this month are skipped for free unless force is set. Each platform is asked at most 3 times a month, at most 10 prompts run per project per month, and the run is refused once the month's buyer-prompt spend reaches $${MONTHLY_PROMPT_COST_CAP_USD.toFixed(2)}. Prompts run two at a time; a prompt the cron is already running is skipped. ChatGPT answers can take up to about 2 minutes. Requires an AI visibility tracker. Read the results with get_ai_visibility_prompt_results.`,
    inputSchema,
    outputSchema: z
      .object({
        period: z.string(),
        costUsd: z.number(),
        outcomes: z.array(looseObjectOutputSchema),
        skipped: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const result = await AiVisibilityPromptService.runPrompts({
      projectId: args.projectId,
      projectDomain: context.project.domain ?? null,
      billingCustomer: context.billing,
      promptIds: args.promptIds,
      force: args.force,
    });
    const count = (key: "ran" | "failed" | "skipped") =>
      result.outcomes.reduce((sum, o) => sum + o[key].length, 0);
    const failed = count("failed");
    const prompts = result.outcomes.length;
    const held = result.skipped.length;
    return mcpResponse({
      text: `Ran ${prompts} prompt${prompts === 1 ? "" : "s"} for ${result.period}: ${count("ran")} answers stored, ${count("skipped")} already captured (free)${failed > 0 ? `, ${failed} failed (the cron retries them)` : ""}.${held > 0 ? ` ${held} prompt${held === 1 ? "" : "s"} not run (${[...new Set(result.skipped.map((x) => x.reason))].join(", ")}).` : ""} DataForSEO cost: $${result.costUsd.toFixed(4)}. Read them with get_ai_visibility_prompt_results.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/brand-lookup`,
      ),
      structuredContent: { ...result },
    });
  }),
};
