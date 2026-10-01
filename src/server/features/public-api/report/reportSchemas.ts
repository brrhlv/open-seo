import { z } from "zod";
import { isIsoDate } from "./reportRequest";

// Request bodies for the report API (BRRHLV-375). Top-level objects are
// strict: an unknown key (e.g. `property`, `siteUrl`, `target`) is a 422, so
// a caller can never redirect a call away from the key's own project.

const isoDate = z.string().refine(isIsoDate, "must be a YYYY-MM-DD date");
// GA4 int64 fields arrive as numbers or decimal strings.
const ga4Int = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/),
]);

/** R1 — GA4 Data API runReport without `property`.
 *  startDate / endDate accept GA4 relative dates (NdaysAgo / today /
 *  yesterday) as-is — GA4 interprets them server-side. */
export const ga4RunReportBodySchema = z.strictObject({
  dateRanges: z
    .array(
      z.strictObject({
        startDate: z.string().min(1),
        endDate: z.string().min(1),
        name: z.string().optional(),
      }),
    )
    .min(1)
    .max(2),
  dimensions: z
    .array(z.looseObject({ name: z.string().min(1) }))
    .max(9)
    .optional(),
  metrics: z
    .array(z.looseObject({ name: z.string().min(1) }))
    .min(1)
    .max(10),
  dimensionFilter: z.record(z.string(), z.unknown()).optional(),
  metricFilter: z.record(z.string(), z.unknown()).optional(),
  orderBys: z.array(z.record(z.string(), z.unknown())).optional(),
  limit: ga4Int
    .refine(
      (v) => Number(v) >= 1 && Number(v) <= 10_000,
      "limit must be 1–10000",
    )
    .optional(),
  offset: ga4Int.optional(),
  keepEmptyRows: z.boolean().optional(),
  metricAggregations: z
    .array(z.enum(["TOTAL", "MAXIMUM", "MINIMUM", "COUNT"]))
    .optional(),
});

/** R2 — Search Console searchAnalytics.query. `groupType` / `operator`
 *  default to Google's own defaults; `dataState` is never defaulted. */
export const gscSearchAnalyticsBodySchema = z.strictObject({
  startDate: isoDate,
  endDate: isoDate,
  dimensions: z
    .array(
      z.enum([
        "query",
        "page",
        "country",
        "device",
        "date",
        "searchAppearance",
        "hour",
      ]),
    )
    .max(7)
    .optional(),
  dimensionFilterGroups: z
    .array(
      z.strictObject({
        groupType: z.enum(["and"]).default("and"),
        filters: z
          .array(
            z.strictObject({
              dimension: z.enum([
                "query",
                "page",
                "country",
                "device",
                "searchAppearance",
              ]),
              operator: z
                .enum([
                  "equals",
                  "notEquals",
                  "contains",
                  "notContains",
                  "includingRegex",
                  "excludingRegex",
                ])
                .default("equals"),
              expression: z.string(),
            }),
          )
          .min(1),
      }),
    )
    .optional(),
  type: z
    .enum(["web", "image", "video", "news", "discover", "googleNews"])
    .optional(),
  aggregationType: z
    .enum(["auto", "byPage", "byProperty", "byNewsShowcasePanel"])
    .optional(),
  rowLimit: z.number().int().min(1).max(25_000).optional(),
  startRow: z.number().int().min(0).optional(),
  dataState: z.enum(["final", "all", "hourly_all"]).optional(),
});

/** R4 — the URL is host-checked against the project domain by the service. */
export const gscInspectUrlBodySchema = z.strictObject({
  inspectionUrl: z.string().min(1).max(2048),
});

const backlinksStatusType = z.enum(["all", "live", "lost"]);

/** R5 — DataForSEO task bodies per kind, WITHOUT `target` (forced by OpenSEO). */
export const backlinksBodySchemas = {
  summary: z.strictObject({
    include_subdomains: z.boolean().optional(),
    internal_list_limit: z.number().int().min(1).max(1000).optional(),
    backlinks_status_type: backlinksStatusType.optional(),
    include_indirect_links: z.boolean().optional(),
  }),
  history: z.strictObject({
    date_from: isoDate.optional(),
    date_to: isoDate.optional(),
  }),
  backlinks: z.strictObject({
    mode: z.enum(["as_is", "one_per_domain", "one_per_anchor"]).optional(),
    filters: z.array(z.unknown()).max(15).optional(),
    order_by: z.array(z.string().min(1)).max(3).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(20_000).optional(),
    backlinks_status_type: backlinksStatusType.optional(),
    include_subdomains: z.boolean().optional(),
  }),
} as const;

export function isBacklinksKind(
  value: string,
): value is keyof typeof backlinksBodySchemas {
  return Object.hasOwn(backlinksBodySchemas, value);
}
