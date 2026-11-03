import { z } from "zod";
import { SearchOpportunityService } from "@/server/features/ga4/services/SearchOpportunityService";
import { Ga4ReportError } from "@/server/lib/ga4Errors";
import {
  GscNotConnectedError,
  isExpectedGrantFailure,
} from "@/server/lib/gscErrors";
import { getCached, setCached } from "@/server/lib/r2-cache";

// CLIENT-SBLV-194: the scored GSC × GA4 opportunity list (the
// get_search_opportunities tool), cached in R2 for 6 h so the summary never
// waits on two 1,000-row Google reads more than a few times a day. The window
// is the service default (28 complete GA4 days), whatever the summary range.

const ROW_LIMIT = 25;
const CACHE_TTL_SECONDS = 6 * 60 * 60;
// A component at or above this percentile counts as a reason.
const STRONG = 0.66;

const cacheKey = (projectId: string) =>
  `public-summary:opportunities:${projectId}`;

const rowSchema = z.object({
  page: z.string(),
  score: z.number().nullable(),
  why: z.array(z.string()),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
  sessions: z.number().nullable(),
  keyEvents: z.number().nullable(),
});
const sectionSchema = z.object({
  connected: z.literal(true),
  capturedAt: z.string(),
  dateRange: z.object({ startDate: z.string(), endDate: z.string() }),
  businessValueMetric: z.string(),
  totalCandidates: z.number(),
  rows: z.array(rowSchema),
});
type OpportunitiesSection = z.infer<typeof sectionSchema>;

type Result = Awaited<
  ReturnType<typeof SearchOpportunityService.getOpportunities>
>;
type Row = Result["rows"][number];

/** Reason codes, strongest first. */
export function whyCodes(row: Row, businessValueMetric: string): string[] {
  const codes: { code: string; weight: number }[] = [];
  const c = row.scoreComponents;
  if (c) {
    if (c.demand >= STRONG)
      codes.push({ code: "high_demand", weight: c.demand });
    if (c.businessValue >= STRONG) {
      codes.push({
        code: businessValueMetric === "engagementRate" ? "engaged" : "converts",
        weight: c.businessValue,
      });
    }
  }
  if (row.position <= 10.5 || (c && c.reachability >= STRONG)) {
    codes.push({ code: "near_page_one", weight: c?.reachability ?? 0.5 });
  }
  codes.sort((a, b) => b.weight - a.weight);
  const out = codes.map((entry) => entry.code);
  if (row.impressions >= 100 && row.ctr < 0.02) out.push("low_ctr");
  if (!row.ga4) out.push("no_analytics");
  return out;
}

function shape(result: Result, now: Date): OpportunitiesSection {
  const metric = result.scoring.businessValueMetric;
  return {
    connected: true,
    capturedAt: now.toISOString(),
    dateRange: result.request.dateRange,
    businessValueMetric: metric,
    totalCandidates: result.totalCandidateRows,
    rows: result.rows.map((row) => ({
      page: row.page,
      score: row.score,
      why: whyCodes(row, metric),
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
      sessions: row.ga4?.sessions ?? null,
      keyEvents: row.ga4?.keyEvents ?? null,
    })),
  };
}

function isUnlinked(error: unknown): boolean {
  return (
    (error instanceof Ga4ReportError && error.code === "ga4_not_connected") ||
    error instanceof GscNotConnectedError ||
    isExpectedGrantFailure(error)
  );
}

export async function getOpportunitiesSection(
  projectId: string,
  now: Date,
): Promise<OpportunitiesSection | { connected: false }> {
  const cached = sectionSchema.safeParse(
    await getCached(cacheKey(projectId)).catch(() => null),
  );
  if (cached.success) return cached.data;

  let result: Result;
  try {
    result = await SearchOpportunityService.getOpportunities(
      { projectId, limit: ROW_LIMIT },
      { now },
    );
  } catch (error) {
    if (isUnlinked(error)) return { connected: false };
    throw error;
  }
  const section = shape(result, now);
  await setCached(cacheKey(projectId), section, CACHE_TTL_SECONDS).catch(
    (error: unknown) => {
      console.error("public-summary: opportunities cache write failed", error);
    },
  );
  return section;
}
