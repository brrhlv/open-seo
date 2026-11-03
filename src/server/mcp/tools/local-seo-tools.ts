/* eslint-disable max-lines */
import { z } from "zod";
import {
  createDataforseoClient,
  fetchBusinessDataTaskResult,
  fetchBusinessListingsCategories,
  type BusinessTaskEndpoint,
  type BusinessTaskOutcome,
} from "@/server/lib/dataforseo";
import {
  RANK_GRID_DEPTH,
  runRankGrid,
  type GridPointResult,
} from "@/server/features/local-grid/services/localRankGrid";
import { AppError } from "@/server/lib/errors";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";
import {
  formatMcpCell,
  formatMcpTable,
  readPath,
  truncatedCell,
  type McpTableColumn,
} from "@/server/mcp/table";
import {
  businessDataNearSchema,
  businessIdentifierInputSchema,
  businessIdentifierKeyword,
  formatBusinessDataCoordinate,
  pickRowFields,
  resolveBusinessIdentifier,
} from "@/server/mcp/tools/local-seo-shared";

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

type BusinessLocationArgs = {
  near?: z.infer<typeof businessDataNearSchema>;
  locationCode?: number;
  languageCode?: string;
};

/** Coordinate when `near` is supplied, otherwise the project's market. */
function resolveBusinessLocation(
  args: BusinessLocationArgs,
  project: { locationCode: number; languageCode: string },
) {
  return {
    locationCoordinate: args.near
      ? formatBusinessDataCoordinate(args.near)
      : undefined,
    locationCode: args.near
      ? undefined
      : (args.locationCode ?? project.locationCode),
    languageCode: args.languageCode ?? project.languageCode,
  };
}

const businessLocationInputSchema = {
  near: businessDataNearSchema.optional(),
  locationCode: locationCodeSchema
    .optional()
    .describe(
      "DataForSEO location code. Ignored when `near` is set; otherwise defaults to the project's market.",
    ),
  languageCode: languageCodeSchema.optional(),
} as const;

// DataForSEO queues these tasks; high priority normally settles them inside the
// poll window, and the tool hands back a resumable taskId when it doesn't.
const TASK_POLL_ATTEMPTS = 6;
const TASK_POLL_INTERVAL_MS = 4000;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollBusinessTask(
  input: { endpoint: BusinessTaskEndpoint; taskId: string },
  publicTaskId: string,
): Promise<BusinessTaskOutcome> {
  try {
    for (let attempt = 0; attempt < TASK_POLL_ATTEMPTS; attempt++) {
      if (attempt > 0) await wait(TASK_POLL_INTERVAL_MS);
      const outcome = await fetchBusinessDataTaskResult(input);
      if (outcome.status === "completed") return outcome;
    }
    return { status: "pending", result: null };
  } catch (error) {
    // The task was already paid for at post; don't let a collection failure
    // discard the only handle to it.
    if (error instanceof AppError) {
      throw new AppError(
        error.code,
        `${error.message} The queued task is still collectable — call again with taskId "${publicTaskId}" at no extra cost.`,
      );
    }
    throw error;
  }
}

function resultItems(result: Record<string, unknown> | null): unknown[] {
  const items = result?.items;
  return Array.isArray(items) ? items : [];
}

// ---------------------------------------------------------------------------
// get_business_profile
// ---------------------------------------------------------------------------

const getBusinessProfileInputSchema = {
  projectId: projectIdSchema,
  ...businessIdentifierInputSchema,
  ...businessLocationInputSchema,
} as const;

type GetBusinessProfileArgs = z.infer<
  z.ZodObject<typeof getBusinessProfileInputSchema>
>;

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

function formatClock(span: unknown, key: "open" | "close"): string {
  const hour = readPath(span, key, "hour");
  const minute = readPath(span, key, "minute");
  if (typeof hour !== "number") return "?";
  const minutes = typeof minute === "number" ? minute : 0;
  return `${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatTimetable(profile: Record<string, unknown>): string {
  const timetable = readPath(profile, "work_time", "work_hours", "timetable");
  if (timetable == null) return "—";
  const days = WEEKDAYS.map((day) => {
    const spans = readPath(timetable, day);
    if (!Array.isArray(spans) || spans.length === 0) {
      return `${day.slice(0, 3)} closed`;
    }
    const hours = spans
      .map(
        (span) => `${formatClock(span, "open")}-${formatClock(span, "close")}`,
      )
      .join(",");
    return `${day.slice(0, 3)} ${hours}`;
  });
  return days.join(" | ");
}

function formatRatingDistribution(profile: Record<string, unknown>): string {
  const distribution = readPath(profile, "rating_distribution");
  if (distribution == null) return "—";
  const stars = [5, 4, 3, 2, 1].map((star) => {
    const count = readPath(distribution, String(star));
    return `${star}★ ${typeof count === "number" ? count : 0}`;
  });
  return stars.join(", ");
}

function formatProfileText(profile: Record<string, unknown>): string {
  const additional = readPath(profile, "additional_categories");
  const category = formatMcpCell(readPath(profile, "category"));
  const lines: Array<[string, string]> = [
    ["title", formatMcpCell(readPath(profile, "title"))],
    [
      "category",
      Array.isArray(additional) && additional.length > 0
        ? `${category} (+ ${additional.map(formatMcpCell).join(", ")})`
        : category,
    ],
    [
      "rating",
      `${formatMcpCell(readPath(profile, "rating", "value"))} from ${formatMcpCell(readPath(profile, "rating", "votes_count"))} reviews`,
    ],
    ["rating breakdown", formatRatingDistribution(profile)],
    ["address", formatMcpCell(readPath(profile, "address"))],
    ["phone", formatMcpCell(readPath(profile, "phone"))],
    ["website", formatMcpCell(readPath(profile, "url"))],
    ["domain", formatMcpCell(readPath(profile, "domain"))],
    ["claimed", formatMcpCell(readPath(profile, "is_claimed"))],
    [
      "status now",
      formatMcpCell(
        readPath(profile, "work_time", "work_hours", "current_status"),
      ),
    ],
    ["hours", formatTimetable(profile)],
    ["photos", formatMcpCell(readPath(profile, "total_photos"))],
    ["cid", formatMcpCell(readPath(profile, "cid"))],
    ["place_id", formatMcpCell(readPath(profile, "place_id"))],
    ["check_url", formatMcpCell(readPath(profile, "check_url"))],
  ];
  return lines.map(([label, value]) => `- ${label}: ${value}`).join("\n");
}

export const getBusinessProfileTool = {
  name: "get_business_profile",
  config: {
    title: "Get business profile",
    description:
      "Reads one Google Business Profile: categories, rating and review count, rating breakdown, address, phone, website, claimed status, opening hours, and photo count. Use it to audit your own profile or to compare a competitor's. Charges credits.",
    inputSchema: getBusinessProfileInputSchema,
    outputSchema: {
      profile: looseObjectOutputSchema.nullable(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: GetBusinessProfileArgs, context) => {
    const identifier = resolveBusinessIdentifier(args);
    const client = createDataforseoClient(context.billing);
    const profile = await client.business.myBusinessInfo({
      keyword: businessIdentifierKeyword(identifier),
      ...resolveBusinessLocation(args, context.project),
    });

    return mcpResponse({
      text: profile
        ? `Google Business Profile:\n${formatProfileText(profile)}`
        : "No Google Business Profile matched that identifier. Try a cid or placeId from get_local_serp_results.",
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: { profile },
    });
  }),
};

// ---------------------------------------------------------------------------
// get_business_reviews
// ---------------------------------------------------------------------------

const getBusinessReviewsInputSchema = {
  projectId: projectIdSchema,
  ...businessIdentifierInputSchema,
  ...businessLocationInputSchema,
  depth: z
    .number()
    .int()
    .min(10)
    .max(200)
    .optional()
    .describe(
      "Number of reviews to collect (10-200). Defaults to 20. Billed per 10 reviews (per 20 when includeOtherSources is true).",
    ),
  sortBy: z
    .enum(["newest", "highest_rating", "lowest_rating", "relevant"])
    .optional()
    .describe(
      "Review sort order. Defaults to newest. Ignored when includeOtherSources is true — the extended endpoint has no sort option.",
    ),
  includeOtherSources: z
    .boolean()
    .optional()
    .describe(
      "Also collect the reviews Google shows from other sites (Yelp, Tripadvisor, Trustpilot). Defaults to false. Costs more per review and cannot be sorted.",
    ),
  taskId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Resume a previous call that returned status "processing". Pass back the taskId exactly as returned (format "google:<id>" or "extended:<id>"); it selects the right endpoint on its own. Resuming charges no extra credits.',
    ),
} as const;

type GetBusinessReviewsArgs = z.infer<
  z.ZodObject<typeof getBusinessReviewsInputSchema>
>;

const REVIEWS_TASK_ID_PATTERN = /^(google|extended):(.+)$/;

function encodeReviewsTaskId(includeOtherSources: boolean, id: string): string {
  return `${includeOtherSources ? "extended" : "google"}:${id}`;
}

function parseReviewsTaskId(taskId: string): {
  endpoint: BusinessTaskEndpoint;
  taskId: string;
} {
  const match = REVIEWS_TASK_ID_PATTERN.exec(taskId);
  if (!match) {
    throw new AppError(
      "VALIDATION_ERROR",
      'taskId must be the value this tool returned, formatted as "google:<id>" or "extended:<id>".',
    );
  }
  return {
    endpoint: match[1] === "extended" ? "extended_reviews" : "reviews",
    taskId: match[2] ?? "",
  };
}

// Full review rows carry ~200-char base64 review URLs, avatar URLs, and
// xpaths; the fields below are what review-gap analysis actually reads.
const REVIEW_ROW_FIELDS = [
  "rank_absolute",
  "time_ago",
  "timestamp",
  "rating",
  "review_text",
  "original_review_text",
  "original_language",
  "profile_name",
  "local_guide",
  "reviews_count",
  "photos_count",
  "review_highlights",
  "source",
  "owner_answer",
  "owner_time_ago",
  "owner_timestamp",
  "review_id",
] as const;

const REVIEW_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "#", value: (row) => readPath(row, "rank_absolute") },
  {
    header: "when",
    value: (row) => readPath(row, "time_ago") ?? readPath(row, "timestamp"),
  },
  { header: "rating", value: (row) => readPath(row, "rating", "value") },
  { header: "author", value: (row) => readPath(row, "profile_name") },
  {
    header: "source",
    value: (row) => readPath(row, "source", "title") ?? "Google",
  },
  {
    header: "review",
    value: (row) => readPath(row, "review_text"),
    format: truncatedCell(120),
  },
  {
    header: "owner replied",
    value: (row) => readPath(row, "owner_answer") != null,
  },
];

export const getBusinessReviewsTool = {
  name: "get_business_reviews",
  config: {
    title: "Get business reviews",
    description:
      "Collects Google reviews for a business, with rating, author, text, and whether the owner replied. Use it for review-gap analysis against competitors and to spot unanswered reviews. Usually completes within this call; if the queued job is still running you get status 'processing' plus a taskId — call again with that taskId in 30-60 seconds to collect the result at no extra cost. Charges credits.",
    inputSchema: getBusinessReviewsInputSchema,
    outputSchema: {
      status: z.enum(["completed", "processing"]),
      taskId: z.string(),
      reviews: z.array(looseObjectOutputSchema).optional(),
      totals: looseObjectOutputSchema.nullable().optional(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: GetBusinessReviewsArgs, context) => {
    const includeOtherSources = args.includeOtherSources ?? false;
    let task: { endpoint: BusinessTaskEndpoint; taskId: string };
    let publicTaskId: string;

    if (args.taskId) {
      task = parseReviewsTaskId(args.taskId);
      publicTaskId = args.taskId;
    } else {
      const identifier = resolveBusinessIdentifier(args);
      const client = createDataforseoClient(context.billing);
      // Only the post is metered; the polling below collects for free.
      const postedId = await client.business.reviewsTaskPost({
        ...identifier,
        ...resolveBusinessLocation(args, context.project),
        depth: args.depth ?? 20,
        // The fetcher's extended branch has no sort_by and ignores this.
        sortBy: args.sortBy ?? "newest",
        includeOtherSources,
      });
      task = {
        endpoint: includeOtherSources ? "extended_reviews" : "reviews",
        taskId: postedId,
      };
      publicTaskId = encodeReviewsTaskId(includeOtherSources, postedId);
    }

    const outcome = await pollBusinessTask(task, publicTaskId);
    if (outcome.status === "pending") {
      return mcpResponse({
        text: `Review collection is still running. Call get_business_reviews again with taskId "${publicTaskId}" in 30-60 seconds — resuming charges no extra credits.`,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structuredContent: { status: "processing", taskId: publicTaskId },
      });
    }

    const reviews = resultItems(outcome.result).map((row) =>
      pickRowFields(row, REVIEW_ROW_FIELDS),
    );
    const totals = outcome.result
      ? {
          title: outcome.result.title ?? null,
          reviews_count: outcome.result.reviews_count ?? null,
          rating: outcome.result.rating ?? null,
          cid: outcome.result.cid ?? null,
          place_id: outcome.result.place_id ?? null,
        }
      : null;

    const header = `Collected ${reviews.length} reviews${typeof totals?.reviews_count === "number" ? ` of ${totals.reviews_count} total` : ""}.`;
    return mcpResponse({
      text:
        reviews.length === 0
          ? `${header} This profile has no reviews matching the request.`
          : `${header} Review text is truncated in this table; full text is in the structured result.\n${formatMcpTable(reviews, REVIEW_COLUMNS)}`,
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: {
        status: "completed",
        taskId: publicTaskId,
        reviews,
        totals,
      },
    });
  }),
};

// ---------------------------------------------------------------------------
// get_business_updates
// ---------------------------------------------------------------------------

const getBusinessUpdatesInputSchema = {
  projectId: projectIdSchema,
  ...businessIdentifierInputSchema,
  ...businessLocationInputSchema,
  depth: z
    .number()
    .int()
    .min(10)
    .max(100)
    .optional()
    .describe("Number of posts to collect (10-100). Defaults to 10."),
  taskId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Resume a previous call that returned status "processing". Pass back the taskId exactly as returned. Resuming charges no extra credits.',
    ),
} as const;

type GetBusinessUpdatesArgs = z.infer<
  z.ZodObject<typeof getBusinessUpdatesInputSchema>
>;

// Post rows ship image CDN URLs and xpaths nothing downstream reads.
const BUSINESS_UPDATE_ROW_FIELDS = [
  "rank_absolute",
  "author",
  "post_date",
  "timestamp",
  "post_text",
  "snippet",
  "url",
  "links",
] as const;

const BUSINESS_UPDATE_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "#", value: (row) => readPath(row, "rank_absolute") },
  {
    header: "posted",
    value: (row) => readPath(row, "post_date") ?? readPath(row, "timestamp"),
  },
  {
    header: "post",
    value: (row) => readPath(row, "post_text") ?? readPath(row, "snippet"),
    format: truncatedCell(120),
  },
  { header: "url", value: (row) => readPath(row, "url") },
];

export const getBusinessUpdatesTool = {
  name: "get_business_updates",
  config: {
    title: "Get business updates",
    description:
      "Collects the posts (updates, offers, events) published on a Google Business Profile. Use it to check posting activity and recency on your profile or a competitor's. Usually completes within this call; a 'processing' response returns a taskId to call back with in 30-60 seconds at no extra cost. Charges credits.",
    inputSchema: getBusinessUpdatesInputSchema,
    outputSchema: {
      status: z.enum(["completed", "processing"]),
      taskId: z.string(),
      updates: z.array(looseObjectOutputSchema).optional(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: GetBusinessUpdatesArgs, context) => {
    let taskId: string;
    if (args.taskId) {
      if (args.taskId.includes(":")) {
        throw new AppError(
          "VALIDATION_ERROR",
          "That looks like a get_business_reviews taskId; pass the bare taskId this tool returned.",
        );
      }
      taskId = args.taskId;
    } else {
      const identifier = resolveBusinessIdentifier(args);
      const client = createDataforseoClient(context.billing);
      taskId = await client.business.updatesTaskPost({
        keyword: businessIdentifierKeyword(identifier),
        ...resolveBusinessLocation(args, context.project),
        depth: args.depth ?? 10,
      });
    }

    const outcome = await pollBusinessTask(
      { endpoint: "my_business_updates", taskId },
      taskId,
    );
    if (outcome.status === "pending") {
      return mcpResponse({
        text: `Post collection is still running. Call get_business_updates again with taskId "${taskId}" in 30-60 seconds — resuming charges no extra credits.`,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structuredContent: { status: "processing", taskId },
      });
    }

    const updates = resultItems(outcome.result).map((row) =>
      pickRowFields(row, BUSINESS_UPDATE_ROW_FIELDS),
    );
    const header = `Collected ${updates.length} Google Business posts.`;
    return mcpResponse({
      text:
        updates.length === 0
          ? `${header} This profile has published no posts.`
          : `${header}\n${formatMcpTable(updates, BUSINESS_UPDATE_COLUMNS)}`,
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: { status: "completed", taskId, updates },
    });
  }),
};

// ---------------------------------------------------------------------------
// list_business_categories
// ---------------------------------------------------------------------------

const BUSINESS_CATEGORIES_CACHE_NAMESPACE = "local:business-categories";
const BUSINESS_CATEGORIES_TTL_SECONDS = 7 * 24 * 60 * 60;

const cachedCategoriesSchema = z.array(
  z.object({ category: z.string(), businessCount: z.number().nullable() }),
);

const listBusinessCategoriesInputSchema = {
  projectId: projectIdSchema,
  query: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      "Case-insensitive substring to match against category slugs (e.g. 'plumb').",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum categories to return (1-200). Defaults to 50."),
} as const;

type ListBusinessCategoriesArgs = z.infer<
  z.ZodObject<typeof listBusinessCategoriesInputSchema>
>;

const BUSINESS_CATEGORY_COLUMNS: McpTableColumn<{
  category: string;
  businessCount: number | null;
}>[] = [
  { header: "category", value: (row) => row.category },
  { header: "businesses", value: (row) => row.businessCount },
];

export const listBusinessCategoriesTool = {
  name: "list_business_categories",
  config: {
    title: "List business categories",
    description:
      "Lists the Google Business categories DataForSEO recognizes, ranked by how many businesses use them. Use it to find valid category slugs for search_local_businesses (e.g. 'pizza_restaurant'). Uses no credits (the full list is cached for 7 days).",
    inputSchema: listBusinessCategoriesInputSchema,
    outputSchema: {
      categories: z.array(
        z.object({
          category: z.string(),
          businessCount: z.number().nullable(),
        }),
      ),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: ListBusinessCategoriesArgs, context) => {
      // The upstream list takes no parameters, so one cache entry serves every
      // query/limit combination; filtering happens below, in memory.
      const cacheKey = await buildCacheKey(
        BUSINESS_CATEGORIES_CACHE_NAMESPACE,
        {},
      );
      const cached = cachedCategoriesSchema.safeParse(
        await getCached(cacheKey),
      );
      let all = cached.success ? cached.data : null;
      if (!all) {
        // Free at DataForSEO, so this skips the metered client — see index.ts.
        all = (await fetchBusinessListingsCategories()).data;
        await setCached(cacheKey, all, BUSINESS_CATEGORIES_TTL_SECONDS);
      }

      const query = args.query?.toLowerCase();
      const matched = query
        ? all.filter((row) => row.category.toLowerCase().includes(query))
        : all;
      const categories = matched.slice(0, args.limit ?? 50);

      const header = `Found ${matched.length} categories${query ? ` matching "${args.query}"` : ""}; showing ${categories.length}.`;
      return mcpResponse({
        text:
          categories.length === 0
            ? header
            : `${header}\n${formatMcpTable(categories, BUSINESS_CATEGORY_COLUMNS)}`,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structuredContent: { categories },
      });
    },
  ),
};

// ---------------------------------------------------------------------------
// get_local_rank_grid
// ---------------------------------------------------------------------------

const getLocalRankGridInputSchema = {
  projectId: projectIdSchema,
  keyword: z
    .string()
    .min(1)
    .max(120)
    .describe("Search query to run on Google Maps at every grid point."),
  target: z
    .object({
      cid: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("Match rows whose cid equals this value (most reliable)."),
      placeId: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe("Match rows whose place_id equals this value."),
      name: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Match rows whose title contains this text (case-insensitive). Used only when cid/placeId do not match.",
        ),
    })
    .describe(
      "The business to locate in each result set. Supply at least one of cid, placeId, or name.",
    ),
  center: z
    .object({
      latitude: z.number().min(-90).max(90).describe("Latitude of the center."),
      longitude: z
        .number()
        .min(-180)
        .max(180)
        .describe("Longitude of the center."),
    })
    .describe("Coordinate the grid is centered on (usually the storefront)."),
  gridSize: z
    .union([z.literal(3), z.literal(5)])
    .optional()
    .describe("Grid width: 3 (9 searches) or 5 (25 searches). Defaults to 3."),
  spacingKm: z
    .number()
    .min(0.25)
    .max(10)
    .optional()
    .describe(
      "Distance between neighbouring grid points, in km. Defaults to 2.",
    ),
  device: z
    .enum(["desktop", "mobile"])
    .optional()
    .describe("Device the SERP is rendered for. Defaults to mobile."),
  zoom: z
    .number()
    .int()
    .min(4)
    .max(18)
    .optional()
    .describe(
      "Map zoom every point is searched at. Defaults to a zoom derived from spacingKm and latitude so each point's viewport spans the grid spacing; override only when you need a specific viewport.",
    ),
  languageCode: languageCodeSchema.optional(),
} as const;

type GetLocalRankGridArgs = z.infer<
  z.ZodObject<typeof getLocalRankGridInputSchema>
>;

function renderGrid(results: GridPointResult[], gridSize: number): string {
  const lines: string[] = [];
  for (let row = 0; row < gridSize; row++) {
    // buildRankGridPoints emits row-major order and results keep it.
    const cells = results
      .slice(row * gridSize, (row + 1) * gridSize)
      .map((point) =>
        (point.error ? "x" : (point.rank?.toString() ?? "–")).padStart(2, " "),
      );
    lines.push(cells.join(" "));
  }
  return lines.join("\n");
}

export const getLocalRankGridTool = {
  name: "get_local_rank_grid",
  config: {
    title: "Get local rank grid",
    description:
      "Runs one Google Maps search per point of a square grid around a coordinate and reports where the target business ranks at each point — plus each point's result count and #1 business — revealing how far its Maps visibility reaches. Cost scales with the grid: gridSize squared SERP calls (3x3 = 9, the sensible default; 5x5 = 25). Charges credits per grid point.",
    inputSchema: getLocalRankGridInputSchema,
    outputSchema: {
      grid: z.array(
        z.object({
          row: z.number(),
          col: z.number(),
          latitude: z.number(),
          longitude: z.number(),
          rank: z.number().nullable(),
          resultsCount: z.number().optional(),
          topResult: z
            .object({
              title: z.string().nullable(),
              cid: z.string().nullable(),
            })
            .nullable()
            .optional(),
          topCompetitor: z
            .object({
              title: z.string().nullable(),
              cid: z.string().nullable(),
              rank: z.number(),
            })
            .nullable()
            .optional(),
          error: z.boolean().optional(),
        }),
      ),
      summary: z.object({
        pointsSearched: z.number(),
        pointsFound: z.number(),
        averageRank: z.number().nullable(),
        top3Count: z.number(),
        top10Count: z.number(),
        solvPct: z.number().nullable(),
        atrp: z.number().nullable(),
      }),
      matchedBusiness: z
        .object({
          title: z.string().nullable(),
          cid: z.string().nullable(),
          placeId: z.string().nullable(),
        })
        .nullable(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: GetLocalRankGridArgs, context) => {
    if (
      args.target.cid == null &&
      args.target.placeId == null &&
      args.target.name == null
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "target needs at least one of cid, placeId, or name.",
      );
    }

    const gridSize = args.gridSize ?? 3;
    const spacingKm = args.spacingKm ?? 2;
    const { grid, summary, matchedBusiness, zoom } = await runRankGrid({
      client: createDataforseoClient(context.billing),
      keyword: args.keyword,
      target: args.target,
      center: args.center,
      gridSize,
      spacingKm,
      device: args.device ?? "mobile",
      languageCode: args.languageCode ?? context.project.languageCode,
      zoom: args.zoom,
    });

    const text = [
      `Local rank grid for "${args.keyword}" (${gridSize}x${gridSize}, ${spacingKm} km spacing, zoom ${zoom}, top ${RANK_GRID_DEPTH} checked).`,
      `Rank per point, north at the top ("–" = not among the results returned there; check that point's resultsCount and topResult before reading it as outranked, "x" = search failed but may still be charged):`,
      renderGrid(grid, gridSize),
      `- ranked at ${summary.pointsFound} of ${summary.pointsSearched} points`,
      `- average rank where found: ${summary.averageRank ?? "—"}`,
      `- top 3 at ${summary.top3Count} points, top 10 at ${summary.top10Count} points`,
    ].join("\n");

    return mcpResponse({
      text,
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: { grid, summary, matchedBusiness },
    });
  }),
};
