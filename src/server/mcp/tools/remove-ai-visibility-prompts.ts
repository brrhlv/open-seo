import { z } from "zod";
import { AiVisibilityPromptService } from "@/server/features/ai-visibility/services/AiVisibilityPromptService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const inputSchema = {
  projectId: projectIdSchema,
  promptIds: z
    .array(z.string().uuid())
    .min(1)
    .max(20)
    .describe("Prompt IDs from list_ai_visibility_prompts."),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const removeAiVisibilityPromptsTool = {
  name: "remove_ai_visibility_prompts",
  config: {
    title: "Remove AI visibility buyer prompts",
    description:
      "Stop tracking buyer prompts. Uses no credits. Stored results are kept, and adding the same prompt text again reactivates it with its history. Unknown or already removed IDs are ignored; `removed` is how many were deactivated.",
    inputSchema,
    outputSchema: z
      .object({ removed: z.number(), ...optionalMetaOutputSchema })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const result = await AiVisibilityPromptService.removePrompts(
      args.projectId,
      args.promptIds,
    );
    const requested = args.promptIds.length;
    return mcpResponse({
      text: `Removed ${result.removed} of ${requested} requested prompt${requested === 1 ? "" : "s"}. Stored results were kept.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/brand-lookup`,
      ),
      structuredContent: { ...result },
    });
  }),
};
