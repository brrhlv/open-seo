import { z } from "zod";
import {
  estimateGridCostUsd,
  LocalGridService,
  keywordsPerRun,
  MAX_ATTEMPTS_PER_MONTH,
  MAX_GRID_KEYWORDS,
} from "@/server/features/local-grid/services/LocalGridService";
import {
  getLocalGridSummary,
  type LocalGridKeywordSummary,
} from "@/server/features/local-grid/services/localGridSummary";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { languageCodeSchema, projectIdSchema } from "@/server/mcp/schemas";

// CLIENT-SBLV-191: the stored monthly Maps rank grid.

const keywordSchema = z.string().trim().min(1).max(120);
const PER_KEYWORD_3X3 = estimateGridCostUsd(3, 1);

// ---------------------------------------------------------------------------
// create_local_grid_tracker
// ---------------------------------------------------------------------------

const createInputSchema = {
  projectId: projectIdSchema,
  keywords: z
    .array(keywordSchema)
    .min(1)
    .max(MAX_GRID_KEYWORDS)
    .describe(
      `Maps queries to grid every month (1-${MAX_GRID_KEYWORDS}). Replaces the tracker's current list.`,
    ),
  target: z
    .object({
      placeId: z.string().min(1).max(256).optional(),
      cid: z.string().min(1).max(64).optional(),
      name: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Display label only; never used to match."),
    })
    .describe(
      "The business, matched by placeId or cid (at least one). Find them with get_local_serp_results or get_business_profile.",
    ),
  center: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .describe("Grid center, usually the Google Business Profile pin."),
  gridSize: z
    .literal(3)
    .optional()
    .describe(
      "3 (9 searches per keyword). 5x5 (25 per keyword) is refused until the Worker is on a paid plan: a cron tick on Workers Free cannot make that many calls.",
    ),
  spacingKm: z
    .number()
    .min(0.25)
    .max(10)
    .optional()
    .describe("Distance between grid points in km. Defaults to 2."),
  device: z.enum(["desktop", "mobile"]).optional(),
  languageCode: languageCodeSchema.optional(),
  scheduleInterval: z
    .enum(["monthly", "manual"])
    .optional()
    .describe(
      "monthly (default) grids on the 2nd of each month; manual only runs via run_local_grid.",
    ),
} as const;

type CreateArgs = z.infer<z.ZodObject<typeof createInputSchema>>;

export const createLocalGridTrackerTool = {
  name: "create_local_grid_tracker",
  config: {
    title: "Create local grid tracker",
    description: `Create (or update) the project's stored Maps rank grid: keywords, business (placeId/cid), center, grid size and spacing. One tracker per project; calling again replaces it and its keyword list (stored history stays) and resets the next scheduled run to the next 2nd of the month. Keywords are stored lowercased. Uses no credits and starts no run. A monthly tracker spends credits on the 2nd of each month: a 3x3 grid is 9 SERP calls per keyword (about $${PER_KEYWORD_3X3.toFixed(3)}). Call get_local_grid first to see an existing tracker.`,
    inputSchema: createInputSchema,
    outputSchema: z
      .object({
        config: looseObjectOutputSchema,
        keywords: z.array(z.string()),
        estimatedMonthlyCostUsd: z.number(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: CreateArgs, context) => {
    const { config, keywords } = await LocalGridService.createTracker({
      projectId: args.projectId,
      keywords: args.keywords,
      target: args.target,
      center: args.center,
      gridSize: args.gridSize,
      spacingKm: args.spacingKm,
      device: args.device,
      languageCode: args.languageCode ?? context.project.languageCode,
      scheduleInterval: args.scheduleInterval,
    });
    const estimatedMonthlyCostUsd = estimateGridCostUsd(
      config.gridSize,
      keywords.length,
    );
    const schedule = config.nextCheckAt
      ? `Next scheduled grid: ${config.nextCheckAt} (about $${estimatedMonthlyCostUsd.toFixed(3)} per month).`
      : "No scheduled runs.";
    return mcpResponse({
      text: `Local grid tracker saved: ${keywords.length} keyword(s), ${config.gridSize}x${config.gridSize}, ${config.spacingKm} km spacing, ${config.scheduleInterval}. ${schedule} No run was started and no credits were used. Use run_local_grid for a baseline now.`,
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: { config, keywords, estimatedMonthlyCostUsd },
    });
  }),
};

// ---------------------------------------------------------------------------
// run_local_grid
// ---------------------------------------------------------------------------

const runInputSchema = {
  projectId: projectIdSchema,
  keywords: z
    .array(keywordSchema)
    .min(1)
    .max(MAX_GRID_KEYWORDS)
    .optional()
    .describe(
      "Only these tracker keywords. Defaults to every tracker keyword without this month's grid.",
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      "Re-run keywords already gridded this month. Replaces the month's grid and spends credits again.",
    ),
} as const;

type RunArgs = z.infer<z.ZodObject<typeof runInputSchema>>;

export const runLocalGridTool = {
  name: "run_local_grid",
  config: {
    title: "Run local grid now",
    description: `Grid the tracker's keywords now and store the result for this month. This spends credits: a 3x3 grid is 9 SERP calls per keyword (about $${PER_KEYWORD_3X3.toFixed(3)}). At most ${keywordsPerRun(3)} keywords per call on 3x3 (27 calls); the rest come back as remaining. Free for keywords already gridded this month (unless force is set). A keyword whose grid fails, or comes back with over a third of its points failed, is retried later, up to ${MAX_ATTEMPTS_PER_MONTH} times a month. Refused while another run (the monthly cron or another call) holds the tracker. Show the user the estimate before calling. Requires a tracker from create_local_grid_tracker; read results with get_local_grid.`,
    inputSchema: runInputSchema,
    outputSchema: z
      .object({
        period: z.string(),
        checked: z.array(looseObjectOutputSchema),
        failed: z.array(looseObjectOutputSchema),
        alreadyCaptured: z.array(z.string()),
        remaining: z.array(z.string()),
        retry: z.array(z.string()),
        gaveUp: z.array(z.string()),
        costUsd: z.number(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: RunArgs, context) => {
    const result = await LocalGridService.runCheck({
      projectId: args.projectId,
      billingCustomer: context.billing,
      keywords: args.keywords,
      force: args.force,
    });
    const lines = result.checked.map(
      (run) =>
        `- ${run.keyword}: found at ${run.pointsFound}/${run.pointsSearched} points, SoLV ${run.solvPct ?? "—"}%, ARP ${run.arp ?? "—"}, ATRP ${run.atrp ?? "—"} ($${run.costUsd.toFixed(4)})${run.degraded ? ` — ${run.pointsFailed} points failed, will retry` : ""}`,
    );
    for (const f of result.failed) {
      lines.push(`- ${f.keyword}: failed (${f.error}), will retry`);
    }
    if (result.alreadyCaptured.length > 0) {
      lines.push(
        `Already gridded for ${result.period} (no credits used): ${result.alreadyCaptured.join(", ")}. Pass force: true to re-run.`,
      );
    }
    if (result.remaining.length > 0) {
      lines.push(
        `Not run yet: ${result.remaining.join(", ")}. Call again to continue.`,
      );
    }
    if (result.gaveUp.length > 0) {
      lines.push(
        `Failed ${MAX_ATTEMPTS_PER_MONTH} times this month, left until next month (force: true to try anyway): ${result.gaveUp.join(", ")}.`,
      );
    }
    return mcpResponse({
      text: `Local grid ${result.period}. DataForSEO cost: $${result.costUsd.toFixed(4)}.\n${lines.join("\n")}\nRead it with get_local_grid.`,
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: { ...result },
    });
  }),
};

// ---------------------------------------------------------------------------
// get_local_grid
// ---------------------------------------------------------------------------

const getInputSchema = { projectId: projectIdSchema } as const;
type GetArgs = z.infer<z.ZodObject<typeof getInputSchema>>;

function signed(value: number | null): string {
  if (value == null) return "n/a";
  return `${value > 0 ? "+" : ""}${value}`;
}

function describeKeyword(row: LocalGridKeywordSummary): string {
  const grid: string[] = [];
  for (let r = 0; r < row.gridSize; r++) {
    grid.push(
      row.cells
        .filter((cell) => cell.row === r)
        .map((cell) =>
          (cell.error ? "x" : (cell.rank?.toString() ?? "–")).padStart(2, " "),
        )
        .join(" "),
    );
  }
  const delta =
    row.delta && row.previous
      ? ` (vs ${row.previous.period}: SoLV ${signed(row.delta.solvPct)} pts, ARP ${signed(row.delta.arp)}, ATRP ${signed(row.delta.atrp)})`
      : " (no previous month yet)";
  return [
    `"${row.keyword}" ${row.period}, ${row.gridSize}x${row.gridSize}: SoLV ${row.solvPct ?? "—"}%, ARP ${row.arp ?? "—"}, ATRP ${row.atrp ?? "—"}${delta}`,
    ...grid,
  ].join("\n");
}

export const getLocalGridTool = {
  name: "get_local_grid",
  config: {
    title: "Get stored local grid",
    description:
      "Read-only access to the project's stored Maps rank grids: per keyword the latest month's rank at each grid point (north at the top), the best competitor per point, SoLV (top-3 share), ARP (average rank where found) and ATRP (average over all points, not found = 21), with the change since the previous month. Uses no credits and makes no DataForSEO call. Use create_local_grid_tracker when no tracker exists and run_local_grid to grid now.",
    inputSchema: getInputSchema,
    outputSchema: z
      .object({
        tracked: z.boolean(),
        keywords: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: GetArgs, context) => {
    const summary = await getLocalGridSummary(args.projectId);
    const header = summary.center
      ? `Local grid tracker${summary.paused ? " (paused)" : ""} for ${summary.target?.name ?? summary.target?.placeId ?? summary.target?.cid}, ${summary.gridSize}x${summary.gridSize} around ${summary.center.latitude},${summary.center.longitude}, ${summary.spacingKm} km spacing, ${summary.scheduleInterval}. Last run: ${summary.lastCheckedAt ?? "never"}. Next: ${summary.nextCheckAt ?? "none"}.`
      : "No local grid tracker for this project.";
    const body =
      summary.keywords.length === 0
        ? "No grids stored yet."
        : `Rank per point, north at the top ("–" = not in the top 20, "x" = search failed):\n${summary.keywords.map(describeKeyword).join("\n\n")}`;
    return mcpResponse({
      text: `${header}\n${body}\nNo credits were used.`,
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: { ...summary },
    });
  }),
};
