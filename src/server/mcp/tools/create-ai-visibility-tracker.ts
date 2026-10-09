import { z } from "zod";
import {
  AiVisibilityService,
  ESTIMATED_RUN_COST_USD,
} from "@/server/features/ai-visibility/services/AiVisibilityService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { BRAND_LOOKUP_MAX_INPUT_LENGTH } from "@/types/schemas/ai-search";

const inputSchema = {
  projectId: projectIdSchema,
  target: z
    .string()
    .trim()
    .min(1)
    .max(BRAND_LOOKUP_MAX_INPUT_LENGTH)
    .optional()
    .describe("Brand name or domain to track. Defaults to the project domain."),
  includeCompetitors: z
    .boolean()
    .optional()
    .describe(
      "Compare share of voice against the project's competitors (project context, up to 5). Defaults to on, except for placeholder brands.",
    ),
  scheduleInterval: z
    .enum(["monthly", "manual"])
    .optional()
    .describe(
      "monthly (default) snapshots on the 1st of each month; manual only runs via run_ai_visibility_check.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const { withoutCompetitors, withCompetitors } = ESTIMATED_RUN_COST_USD;

export const createAiVisibilityTrackerTool = {
  name: "create_ai_visibility_tracker",
  config: {
    title: "Create AI visibility tracker",
    description: `Create (or update) the project's AI-visibility tracker. One tracker per project; calling again updates it. Creating it uses no credits and starts no check. A monthly tracker spends credits on the 1st of each month: up to about $${withoutCompetitors.toFixed(2)} per run, or $${withCompetitors.toFixed(2)} with competitors. Call get_ai_visibility first to see an existing tracker.`,
    inputSchema,
    outputSchema: z
      .object({
        config: looseObjectOutputSchema,
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
    const config = await AiVisibilityService.createTracker({
      projectId: args.projectId,
      projectDomain: context.project.domain,
      target: args.target,
      includeCompetitors: args.includeCompetitors,
      scheduleInterval: args.scheduleInterval,
    });
    const schedule = config.nextCheckAt
      ? `Next scheduled check: ${config.nextCheckAt}.`
      : "No scheduled checks.";
    return mcpResponse({
      text: `AI visibility tracker saved for ${config.target} (${config.scheduleInterval}, competitors ${config.includeCompetitors ? "on" : "off"}). ${schedule} No check was started and no credits were used. Use run_ai_visibility_check for a baseline now.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/brand-lookup`,
      ),
      structuredContent: { config },
    });
  }),
};
