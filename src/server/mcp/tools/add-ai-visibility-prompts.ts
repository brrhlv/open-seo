import { sort } from "remeda";
import { z } from "zod";
import { AI_VISIBILITY_PROMPT_PLATFORMS } from "@/db/ai-visibility.schema";
import {
  AiVisibilityPromptService,
  ESTIMATED_PROMPT_RUN_COST_USD,
  MAX_ACTIVE_PROMPTS,
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
  prompts: z
    .array(z.string().min(3).max(300))
    .min(1)
    .max(MAX_ACTIVE_PROMPTS)
    .describe(
      "Buyer prompts, phrased the way a customer would ask an AI assistant, e.g. 'best photo booth company for a corporate event in Las Vegas'.",
    ),
  platforms: z
    .array(z.enum(AI_VISIBILITY_PROMPT_PLATFORMS))
    .min(1)
    .optional()
    .describe(
      "Platforms to ask. Defaults to all three: chat_gpt, google_ai_mode, perplexity.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const perPrompt = ESTIMATED_PROMPT_RUN_COST_USD.toFixed(3);

export const addAiVisibilityPromptsTool = {
  name: "add_ai_visibility_prompts",
  config: {
    title: "Add AI visibility buyer prompts",
    description: `Track buyer prompts for the project. Once a month each prompt is asked of ChatGPT, Google AI Mode and Perplexity; the result records whether the brand is named, its position among the brands named, the cited page and the competitors named. New and re-added prompts run on the next monthly check (the 1st, before the monthly report), never mid-month, then every month: about $${perPrompt} per prompt per month on all three platforms. Show the user that cost before adding. To get answers sooner, call run_ai_visibility_prompts explicitly (it spends the same amount now). At most ${MAX_ACTIVE_PROMPTS} active prompts per project; re-adding a removed prompt reactivates it with its history. Needs an AI visibility tracker (create_ai_visibility_tracker) on a monthly schedule.`,
    inputSchema,
    outputSchema: z
      .object({
        added: z.number(),
        reactivated: z.number(),
        unchanged: z.number(),
        prompts: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const result = await AiVisibilityPromptService.addPrompts({
      projectId: args.projectId,
      prompts: args.prompts,
      platforms: args.platforms,
    });
    const scheduled = result.added + result.reactivated;
    const firstRun =
      sort(
        result.prompts.flatMap((p) => (p.nextRunAt ? [p.nextRunAt] : [])),
        (a, b) => a.localeCompare(b),
      )[0]?.slice(0, 10) ?? "the 1st";
    const next =
      scheduled > 0
        ? `${scheduled} prompt${scheduled === 1 ? "" : "s"} will run on the next monthly check (${firstRun}, before the monthly report; about $${(scheduled * ESTIMATED_PROMPT_RUN_COST_USD).toFixed(3)}), then monthly. Use run_ai_visibility_prompts to run them now.`
        : "Nothing new to run.";
    const total = result.prompts.length;
    return mcpResponse({
      text: `Added ${result.added}, reactivated ${result.reactivated}, already tracked ${result.unchanged}. ${next} The project now tracks ${total} active prompt${total === 1 ? "" : "s"}.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/brand-lookup`,
      ),
      structuredContent: { ...result },
    });
  }),
};
