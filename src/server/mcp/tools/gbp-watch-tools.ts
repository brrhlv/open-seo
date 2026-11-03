import { z } from "zod";
import { gbpExpectedSchema } from "@/server/features/gbp-watch/gbpWatchModel";
import type { GbpWatchView } from "@/server/features/gbp-watch/gbpWatchView";
import {
  ESTIMATED_RUN_COST_USD,
  GbpWatchService,
} from "@/server/features/gbp-watch/services/GbpWatchService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

// CLIENT-SBLV-193: the Google Business Profile watch. get_gbp_watch is a free
// read of stored snapshots; run_gbp_snapshot spends credits; set_gbp_watch
// writes the project's watch config.

const projectOnly = { projectId: projectIdSchema } as const;

// ---------------------------------------------------------------------------
// get_gbp_watch
// ---------------------------------------------------------------------------

function signed(value: number | null): string {
  if (value === null) return "";
  return value === 0 ? " (no change)" : ` (${value > 0 ? "+" : ""}${value})`;
}

function describeWatch(view: GbpWatchView): string {
  const p = view.profile;
  if (!p) return "No snapshot stored yet.";
  const lines = [
    `Latest snapshot ${p.capturedAt ?? "?"}: ${p.title ?? "?"}, ${p.primaryCategory ?? "no primary category"}${p.additionalCategories.length ? ` (+ ${p.additionalCategories.join(", ")})` : ""}.`,
    `- rating ${view.rating.value ?? "n/a"}${signed(view.rating.valueChange)} from ${view.rating.reviewCount ?? "n/a"} reviews${signed(view.rating.reviewCountChange)}; ${view.newReviewCount === null ? "reviews not collected in the latest snapshot" : `${view.newReviewCount} new since the previous snapshot`}`,
    `- website ${p.website ?? "none"}; hours ${p.hoursText ?? "none listed"}`,
    `- unanswered Q&A: ${view.questionsAvailable ? view.unansweredQuestions.length : "Google shows no Q&A"}`,
  ];
  lines.push(
    view.changes.length
      ? `- changes (90 days): ${view.changes.map((c) => `${c.field} "${c.from ?? "none"}" -> "${c.to ?? "none"}" (${c.detectedAt})`).join("; ")}`
      : "- no profile changes in the last 90 days",
  );
  lines.push(
    view.driftFromExpected.length
      ? `- drift from the accepted state: ${view.driftFromExpected.map((d) => `${d.rule} ${d.actual ?? "none"} (expected ${d.expected ?? "none"}, since ${d.since ?? "?"})`).join("; ")}`
      : "- matches the accepted state",
  );
  return lines.join("\n");
}

export const getGbpWatchTool = {
  name: "get_gbp_watch",
  config: {
    title: "Get GBP watch",
    description:
      "Read-only access to the project's stored Google Business Profile watch: the latest profile snapshot (categories, website, hours, rating, review count), the change in rating and review count since the previous snapshot, the latest 5 reviews with owner-reply status, unanswered Q&A, recent owner posts, profile changes in the last 90 days, and drift from the accepted state. Uses no credits and makes no DataForSEO call. Use set_gbp_watch to create the watch and run_gbp_snapshot to capture one now.",
    inputSchema: projectOnly,
    outputSchema: z
      .object({
        tracked: z.boolean(),
        profile: looseObjectOutputSchema.nullable(),
        changes: z.array(looseObjectOutputSchema),
        driftFromExpected: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof projectOnly>>, context) => {
      const view = await GbpWatchService.getWatch(args.projectId);
      const header = view.expected
        ? `GBP watch (${view.tracked ? "active" : "paused"}) for ${view.cid ? `cid ${view.cid}` : `place ${view.placeId}`}. Last checked: ${view.lastCheckedAt ?? "never"}; next: ${view.nextCheckAt ?? "manual only"}.${view.lastError ? ` Last error: ${view.lastError}` : ""}`
        : "No GBP watch for this project. Create one with set_gbp_watch.";
      return mcpResponse({
        text: `${header}\n${describeWatch(view)}\nNo credits were used.`,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structuredContent: { ...view },
      });
    },
  ),
};

// ---------------------------------------------------------------------------
// run_gbp_snapshot
// ---------------------------------------------------------------------------

const runInputSchema = {
  projectId: projectIdSchema,
  force: z
    .boolean()
    .optional()
    .describe(
      "Run even when a snapshot was taken in the last hour (spends credits again).",
    ),
} as const;

export const runGbpSnapshotTool = {
  name: "run_gbp_snapshot",
  config: {
    title: "Run GBP snapshot",
    description: `Snapshot the project's Google Business Profile now (DataForSEO profile, newest reviews, Q&A and owner posts) and store the changes since the last snapshot. This spends credits: about $${ESTIMATED_RUN_COST_USD.toFixed(3)} per run. Show the user the estimate before calling. Free when a snapshot was taken in the last hour (unless force is set). Takes up to ~30 seconds while the review and post tasks settle. Requires a watch from set_gbp_watch. Read the result with get_gbp_watch.`,
    inputSchema: runInputSchema,
    outputSchema: z
      .object({
        status: z.enum(["checked", "already_captured"]),
        capturedAt: z.string(),
        costUsd: z.number(),
        changes: z.number(),
        drift: z.number(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof runInputSchema>>, context) => {
      const result = await GbpWatchService.runSnapshot({
        projectId: args.projectId,
        billingCustomer: context.billing,
        market: {
          locationCode: context.project.locationCode,
          languageCode: context.project.languageCode,
        },
        force: args.force,
      });
      const missing = Object.entries(result.collected)
        .filter(([, collected]) => !collected)
        .map(([list]) => list);
      const text =
        result.status === "already_captured"
          ? `A snapshot was taken at ${result.capturedAt}. No DataForSEO call was made and no credits were used. Pass force: true to run again.`
          : `Captured the Google Business Profile at ${result.capturedAt}: ${result.changes} change(s) since the previous snapshot, ${result.drift} difference(s) from the accepted state.${missing.length ? ` Not collected this run: ${missing.join(", ")}.` : ""} DataForSEO cost: $${result.costUsd.toFixed(4)}. Read it with get_gbp_watch.`;
      return mcpResponse({
        text,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structuredContent: { ...result },
      });
    },
  ),
};

// ---------------------------------------------------------------------------
// set_gbp_watch
// ---------------------------------------------------------------------------

const setInputSchema = {
  projectId: projectIdSchema,
  cid: z
    .string()
    .regex(/^\d{1,30}$/)
    .optional()
    .describe(
      "Google CID of the profile (from get_local_serp_results). Preferred identifier.",
    ),
  placeId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Google Maps place_id, used when there is no cid."),
  listingId: z
    .string()
    .regex(/^\d{1,30}$/)
    .optional()
    .describe(
      "GBP manager listing id (business.google.com/.../<id>), shown as an edit link only.",
    ),
  expected: gbpExpectedSchema
    .optional()
    .describe(
      "The accepted state: primaryCategory, allowedAdditionalCategories, forbiddenCategories, website, hours ({ monday: ['09:00-21:00'], ... }; a missing day is closed). Replaces the stored value when given.",
    ),
  includeQuestions: z
    .boolean()
    .optional()
    .describe(
      "Collect Q&A each run ($0.0054, billed even when empty; Google retired the Q&A module in 2025). Defaults to true.",
    ),
  scheduleInterval: z
    .enum(["weekly", "manual"])
    .optional()
    .describe(
      "weekly (default) snapshots on Mondays 14:00 UTC; manual only runs via run_gbp_snapshot.",
    ),
  active: z.boolean().optional().describe("Pause (false) or resume the watch."),
} as const;

export const setGbpWatchTool = {
  name: "set_gbp_watch",
  config: {
    title: "Set GBP watch",
    description: `Create or update the project's Google Business Profile watch (one per project; omitted fields keep their stored values). Uses no credits and starts no snapshot. A weekly watch spends about $${ESTIMATED_RUN_COST_USD.toFixed(3)} every Monday. Call get_gbp_watch first to see the current watch.`,
    inputSchema: setInputSchema,
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
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof setInputSchema>>, context) => {
      const config = await GbpWatchService.setWatch(args);
      const schedule = config.nextCheckAt
        ? `Next snapshot: ${config.nextCheckAt}.`
        : "No scheduled snapshots.";
      return mcpResponse({
        text: `GBP watch saved (${config.scheduleInterval}${config.isActive ? "" : ", paused"}, Q&A ${config.includeQuestions ? "on" : "off"}). ${schedule} No snapshot was started and no credits were used. Use run_gbp_snapshot for a baseline now.`,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structuredContent: { config },
      });
    },
  ),
};
