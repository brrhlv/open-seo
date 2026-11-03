import { z } from "zod";
import { AiVisibilityPromptService } from "@/server/features/ai-visibility/services/AiVisibilityPromptService";
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
  includeInactive: z
    .boolean()
    .optional()
    .describe("Also list removed prompts (their history is kept)."),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const listAiVisibilityPromptsTool = {
  name: "list_ai_visibility_prompts",
  config: {
    title: "List AI visibility buyer prompts",
    description:
      "List the project's tracked buyer prompts with their platforms and schedule (next run, last run, last error). Uses no credits. Read the answers with get_ai_visibility_prompt_results.",
    inputSchema,
    outputSchema: z
      .object({
        prompts: z.array(looseObjectOutputSchema),
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
    const prompts = await AiVisibilityPromptService.listPrompts(
      args.projectId,
      { includeInactive: args.includeInactive },
    );
    const lines = prompts.map(
      (p) =>
        `- ${p.id}${p.isActive ? "" : " (removed)"}: "${p.prompt}" [${p.platforms.join(", ")}] next ${p.nextRunAt ?? "n/a"}, last ${p.lastRunAt ?? "never"}${p.lastError ? `, last error: ${p.lastError}` : ""}`,
    );
    const count = prompts.length;
    return mcpResponse({
      text:
        count === 0
          ? "No buyer prompts are tracked for this project. Add some with add_ai_visibility_prompts."
          : `${count} buyer prompt${count === 1 ? "" : "s"}:\n${lines.join("\n")}\nNo credits were used.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/brand-lookup`,
      ),
      structuredContent: { prompts },
    });
  }),
};
