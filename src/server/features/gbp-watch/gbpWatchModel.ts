import { sort } from "remeda";
import { z } from "zod";
import { readPath } from "@/server/mcp/table";

/**
 * CLIENT-SBLV-193: pure shaping for the GBP watch. Normalizes DataForSEO
 * business rows into the stored snapshot shape. The snapshot diff and the
 * accepted-state check live in gbpWatchDiff.ts. No I/O.
 */

export const GBP_WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type Weekday = (typeof GBP_WEEKDAYS)[number];

/** Every weekday present; `[]` = closed. Spans are "HH:MM-HH:MM". */
export type GbpHours = Record<Weekday, string[]>;

const SPAN_PATTERN = /^\d{2}:\d{2}-\d{2}:\d{2}$/;
const spans = z.array(z.string().regex(SPAN_PATTERN)).max(6).default([]);
const hoursSchema = z.object({
  monday: spans,
  tuesday: spans,
  wednesday: spans,
  thursday: spans,
  friday: spans,
  saturday: spans,
  sunday: spans,
});

const categoryName = z.string().trim().min(1).max(120);

/** The accepted state a profile is checked against. Every key is optional. */
export const gbpExpectedSchema = z
  .object({
    primaryCategory: categoryName.optional(),
    /** When set, an additional category outside this list is drift. */
    allowedAdditionalCategories: z.array(categoryName).max(20).optional(),
    /** Categories that must never appear, primary or additional. */
    forbiddenCategories: z.array(categoryName).max(20).optional(),
    website: z.string().trim().url().max(300).optional(),
    hours: hoursSchema.optional(),
  })
  .strict();
export type GbpExpected = z.infer<typeof gbpExpectedSchema>;

/** A stored expected_json; a malformed value means "no expectations". */
export function parseExpected(json: string | null | undefined): GbpExpected {
  try {
    const parsed = gbpExpectedSchema.safeParse(JSON.parse(json ?? "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export type GbpProfile = {
  title: string | null;
  primaryCategory: string | null;
  additionalCategories: string[];
  website: string | null;
  phone: string | null;
  address: string | null;
  description: string | null;
  hours: GbpHours | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  reviewCount: number | null;
  totalPhotos: number | null;
  isClaimed: boolean | null;
};

export type GbpReview = {
  reviewId: string | null;
  author: string | null;
  rating: number | null;
  text: string | null;
  publishedAt: string | null;
  ownerReplied: boolean;
  ownerRepliedAt: string | null;
  isNew: boolean;
};

export type GbpUpdate = {
  key: string;
  postedAt: string | null;
  text: string | null;
  url: string | null;
  isNew: boolean;
};

export const GBP_WATCHED_FIELDS = [
  "title",
  "primaryCategory",
  "additionalCategories",
  "website",
  "phone",
  "address",
  "hours",
  "isClaimed",
] as const;
export type GbpField = (typeof GBP_WATCHED_FIELDS)[number];

export type GbpChange = {
  field: GbpField;
  from: string | null;
  to: string | null;
  detectedAt: string;
};

export type GbpDriftRule =
  | "primary_category"
  | "forbidden_category"
  | "unexpected_category"
  | "website"
  | "hours";

export type GbpDrift = {
  field: "primaryCategory" | "additionalCategories" | "website" | "hours";
  rule: GbpDriftRule;
  expected: string | null;
  actual: string | null;
};

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** DataForSEO stamps ("2026-10-29 14:38:59 +00:00") as ISO; null if unusable. */
function dfsTimestamp(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const match =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ?([+-]\d{2}:?\d{2})$/.exec(raw);
  const ms = Date.parse(match ? `${match[1]}T${match[2]}${match[3]}` : raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function clock(span: unknown, key: "open" | "close"): string | null {
  const hour = num(readPath(span, key, "hour"));
  if (hour === null) return null;
  const minute = num(readPath(span, key, "minute")) ?? 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeHours(workTime: unknown): GbpHours | null {
  const timetable = readPath(workTime, "work_hours", "timetable");
  if (typeof timetable !== "object" || timetable === null) return null;
  const day = (name: Weekday) => {
    const list = readPath(timetable, name);
    // "HH:MM-HH:MM" sorts as text; Google's span order is not stable.
    const slots = (Array.isArray(list) ? list : []).flatMap((span) => {
      const open = clock(span, "open");
      const close = clock(span, "close");
      return open && close ? [`${open}-${close}`] : [];
    });
    return sort(slots, (a, b) => a.localeCompare(b));
  };
  return {
    monday: day("monday"),
    tuesday: day("tuesday"),
    wednesday: day("wednesday"),
    thursday: day("thursday"),
    friday: day("friday"),
    saturday: day("saturday"),
    sunday: day("sunday"),
  };
}

/** One my_business_info item → the stored profile fields. */
export function normalizeProfile(item: Record<string, unknown>): GbpProfile {
  const additional = readPath(item, "additional_categories");
  const claimed = readPath(item, "is_claimed");
  return {
    title: str(item.title),
    primaryCategory: str(item.category),
    additionalCategories: Array.isArray(additional)
      ? additional.flatMap((c) => (str(c) ? [String(c).trim()] : []))
      : [],
    website: str(item.url),
    phone: str(item.phone),
    address: str(item.address),
    description: str(item.description),
    hours: normalizeHours(item.work_time),
    latitude: num(item.latitude),
    longitude: num(item.longitude),
    rating: num(readPath(item, "rating", "value")),
    reviewCount: num(readPath(item, "rating", "votes_count")),
    totalPhotos: num(item.total_photos),
    isClaimed: typeof claimed === "boolean" ? claimed : null,
  };
}

/**
 * Reviews newest first. `previousIds` = ids collected by the last snapshot
 * that has reviews; null on the first (baseline) snapshot, where nothing is new.
 */
export function normalizeReviews(
  items: unknown[],
  previousIds: Set<string> | null,
): GbpReview[] {
  return items.map((row) => {
    const reviewId = str(readPath(row, "review_id"));
    return {
      reviewId,
      author: str(readPath(row, "profile_name")),
      rating: num(readPath(row, "rating", "value")),
      text:
        str(readPath(row, "review_text")) ??
        str(readPath(row, "original_review_text")),
      publishedAt: dfsTimestamp(readPath(row, "timestamp")),
      ownerReplied: readPath(row, "owner_answer") != null,
      ownerRepliedAt: dfsTimestamp(readPath(row, "owner_timestamp")),
      isNew:
        previousIds !== null && reviewId !== null && !previousIds.has(reviewId),
    };
  });
}

/** Owner posts newest first, keyed by URL (or stamp + text when there is none). */
export function normalizeUpdates(
  items: unknown[],
  previousKeys: Set<string> | null,
): GbpUpdate[] {
  return items.map((row) => {
    const url = str(readPath(row, "url"));
    const text =
      str(readPath(row, "post_text")) ?? str(readPath(row, "snippet"));
    const postedAt =
      dfsTimestamp(readPath(row, "timestamp")) ??
      str(readPath(row, "post_date"));
    const key = url ?? `${postedAt ?? ""}|${(text ?? "").slice(0, 60)}`;
    return {
      key,
      postedAt,
      text,
      url,
      isNew: previousKeys !== null && !previousKeys.has(key),
    };
  });
}
