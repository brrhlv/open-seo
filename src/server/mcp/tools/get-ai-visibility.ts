import { z } from "zod";
import { AiVisibilityService } from "@/server/features/ai-visibility/services/AiVisibilityService";
import type { AiVisibilityPlatformSummary } from "@/server/features/ai-visibility/services/aiVisibilitySnapshots";
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
  months: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe("Months of stored history to return. Defaults to 12."),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const PLATFORM_LABELS = { chat_gpt: "ChatGPT", google: "Google AI Overview" };

function signed(value: number | null, suffix = ""): string {
  if (value == null) return "n/a";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}${suffix}`;
}

function describePlatform(row: AiVisibilityPlatformSummary): string {
  const sov =
    row.shareOfVoicePct == null
      ? "no share of voice"
      : `share of voice ${row.shareOfVoicePct.toFixed(1)}%`;
  const delta =
    row.delta && row.previous
      ? ` (vs ${row.previous.period}: mentions ${signed(row.delta.mentions)}, cited pages ${signed(row.delta.citedPages)}, SoV ${signed(row.delta.shareOfVoicePct, " pts")})`
      : " (no previous month yet)";
  return `- ${PLATFORM_LABELS[row.platform]} ${row.period}: ${row.mentions ?? "n/a"} mentions, ${row.citedPages} cited pages, ${sov}${delta}`;
}

export const getAiVisibilityTool = {
  name: "get_ai_visibility",
  config: {
    title: "Get AI visibility history",
    description:
      "Read-only access to the project's stored AI-visibility snapshots: per platform (ChatGPT, Google AI Overview) the latest month's brand mentions, cited pages, share of voice vs the project's competitors, top cited sources and sample prompts, with month-over-month deltas and history. Uses no credits and makes no DataForSEO call. Use create_ai_visibility_tracker when no tracker exists and run_ai_visibility_check to capture a month on demand.",
    inputSchema,
    outputSchema: z
      .object({
        config: looseObjectOutputSchema.nullable(),
        latest: z.array(looseObjectOutputSchema),
        history: z.array(looseObjectOutputSchema),
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
    const result = await AiVisibilityService.getHistory(
      args.projectId,
      args.months,
    );
    const { config } = result;
    const header = config
      ? `AI visibility tracker for ${config.target} (${config.scheduleInterval}${config.isActive ? "" : ", paused"}, competitors ${config.includeCompetitors ? "on" : "off"}). Last checked: ${config.lastCheckedAt ?? "never"}.${config.lastError ? ` Last error: ${config.lastError}` : ""}`
      : "No AI visibility tracker for this project.";
    const body =
      result.latest.length === 0
        ? "No snapshots stored yet."
        : result.latest.map(describePlatform).join("\n");
    return mcpResponse({
      text: `${header}\n${body}\nNo credits were used.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/brand-lookup`,
      ),
      structuredContent: { ...result },
    });
  }),
};
