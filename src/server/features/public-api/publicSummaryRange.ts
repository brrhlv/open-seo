import { z } from "zod";
import type { ComparePeriod } from "@/types/schemas/rank-tracking";
import { GSC_DATA_LAG_DAYS } from "@/server/features/gsc/searchAnalytics";

const publicSummaryRangeSchema = z.enum([
  "last_7_days",
  "last_28_days",
  "last_90_days",
]);
export type PublicSummaryRange = z.infer<typeof publicSummaryRangeSchema>;

const RANGE_DAYS: Record<PublicSummaryRange, number> = {
  last_7_days: 7,
  last_28_days: 28,
  last_90_days: 90,
};

/** Rank movement compares against the snapshot nearest the window start. */
export const RANK_COMPARE_PERIOD: Record<PublicSummaryRange, ComparePeriod> = {
  last_7_days: "7d",
  last_28_days: "30d",
  last_90_days: "90d",
};

// GSC data trails ~2-3 days. Ending the GSC and GA4 windows on the same lagged
// day keeps both sources on identical dates in one response.
const DATA_LAG_DAYS = GSC_DATA_LAG_DAYS;

/** Absent (`null`) → the default; anything unsupported → null (HTTP 422). */
export function parsePublicSummaryRange(
  raw: string | null,
): PublicSummaryRange | null {
  const parsed = publicSummaryRangeSchema.safeParse(raw ?? "last_28_days");
  return parsed.success ? parsed.data : null;
}

/** N inclusive UTC days ending DATA_LAG_DAYS before `now`. */
export function resolvePublicSummaryDates(
  range: PublicSummaryRange,
  now: Date = new Date(),
): { start: string; end: string } {
  const end = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - DATA_LAG_DAYS,
    ),
  );
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (RANGE_DAYS[range] - 1));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}
