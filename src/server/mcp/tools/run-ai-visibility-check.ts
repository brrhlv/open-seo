import { z } from "zod";
import {
  AiVisibilityService,
  ESTIMATED_RUN_COST_USD,
} from "@/server/features/ai-visibility/services/AiVisibilityService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const inputSchema = {
  projectId: projectIdSchema,
  force: z
    .boolean()
    .optional()
    .describe(
      "Re-run even when this month is already captured. A repeat within 24 hours reuses the cached lookup at no cost.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const { withoutCompetitors, withCompetitors } = ESTIMATED_RUN_COST_USD;

export const runAiVisibilityCheckTool = {
  name: "run_ai_visibility_check",
  config: {
    title: "Run AI visibility check",
    description: `Capture this month's AI-visibility snapshot now (DataForSEO LLM Mentions for ChatGPT and Google AI Overview). This spends credits: up to about $${withoutCompetitors.toFixed(2)} per run, or $${withCompetitors.toFixed(2)} when the tracker compares competitors (smaller brands cost less). Show the user the estimate before calling. Free when the month is already captured (unless force is set) or when the same lookup ran in the last 24 hours. Requires a tracker from create_ai_visibility_tracker. Read the stored result with get_ai_visibility.`,
    inputSchema,
    outputSchema: z
      .object({
        status: z.enum(["checked", "already_captured"]),
        period: z.string(),
        costUsd: z.number(),
        platforms: z.array(z.string()),
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
    const result = await AiVisibilityService.runCheck({
      projectId: args.projectId,
      billingCustomer: context.billing,
      force: args.force,
    });
    const text =
      result.status === "already_captured"
        ? `AI visibility for ${result.period} is already captured. No DataForSEO call was made and no credits were used. Pass force: true to re-run.`
        : `Captured AI visibility for ${result.period} (${result.platforms.join(", ")}). DataForSEO cost: $${result.costUsd.toFixed(4)}${result.costUsd === 0 ? " (cached lookup)" : ""}. Read it with get_ai_visibility.`;
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/brand-lookup`,
      ),
      structuredContent: { ...result },
    });
  }),
};
