import { z } from "zod";
import type {
  GbpSnapshotInsert,
  GbpSnapshotRow,
} from "@/server/features/gbp-watch/repositories/GbpWatchRepository";
import {
  GBP_WATCHED_FIELDS,
  type GbpChange,
  type GbpHours,
  type GbpProfile,
  type GbpReview,
  type GbpUpdate,
} from "./gbpWatchModel";

/**
 * CLIENT-SBLV-193: gbp_snapshots row <-> profile and lists. The JSON columns
 * are written only by GbpWatchService, but are still parsed defensively: a
 * bad row reads as "not collected" instead of breaking the summary.
 */

const nullableString = z.string().nullable();

const reviewSchema = z.object({
  reviewId: nullableString,
  author: nullableString,
  rating: z.number().nullable(),
  text: nullableString,
  publishedAt: nullableString,
  ownerReplied: z.boolean(),
  ownerRepliedAt: nullableString,
  isNew: z.boolean(),
});

const updateSchema = z.object({
  key: z.string(),
  postedAt: nullableString,
  text: nullableString,
  url: nullableString,
  isNew: z.boolean(),
});

const changeSchema = z.object({
  field: z.enum(GBP_WATCHED_FIELDS),
  from: nullableString,
  to: nullableString,
  detectedAt: z.string(),
});

const spans = z.array(z.string());
const hoursSchema = z.object({
  monday: spans,
  tuesday: spans,
  wednesday: spans,
  thursday: spans,
  friday: spans,
  saturday: spans,
  sunday: spans,
});

function parseJson<T>(json: string | null, schema: z.ZodType<T>): T | null {
  if (json === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const readReviews = (row: GbpSnapshotRow): GbpReview[] | null =>
  parseJson(row.reviewsJson, z.array(reviewSchema));
export const readUpdates = (row: GbpSnapshotRow): GbpUpdate[] | null =>
  parseJson(row.updatesJson, z.array(updateSchema));
export const readChanges = (row: GbpSnapshotRow): GbpChange[] =>
  parseJson(row.changesJson, z.array(changeSchema)) ?? [];

/**
 * The leading rows about the same profile as the newest one: a changed cid
 * or place_id starts a new baseline (no diff, nothing "new"). Rows from
 * before identifiers were stored (null) count as the same profile.
 */
export function sameProfileRun<T extends Pick<GbpSnapshotRow, "identifier">>(
  rows: T[],
  identifier: string | null = rows[0]?.identifier ?? null,
): T[] {
  const end = rows.findIndex(
    (row) =>
      row.identifier !== null &&
      identifier !== null &&
      row.identifier !== identifier,
  );
  return end === -1 ? rows : rows.slice(0, end);
}

export function profileFromRow(row: GbpSnapshotRow): GbpProfile {
  const hours: GbpHours | null = parseJson(row.hoursJson, hoursSchema);
  return {
    title: row.title,
    primaryCategory: row.primaryCategory,
    additionalCategories:
      parseJson(row.additionalCategoriesJson, z.array(z.string())) ?? [],
    website: row.website,
    phone: row.phone,
    address: row.address,
    description: row.description,
    hours,
    latitude: row.latitude,
    longitude: row.longitude,
    rating: row.rating,
    reviewCount: row.reviewCount,
    totalPhotos: row.totalPhotos,
    isClaimed: row.isClaimed,
  };
}

const toJson = <T>(value: T | null): string | null =>
  value === null ? null : JSON.stringify(value);

export function snapshotInsert(input: {
  projectId: string;
  identifier: string;
  capturedAt: string;
  profile: GbpProfile;
  reviews: GbpReview[] | null;
  updates: GbpUpdate[] | null;
  changes: GbpChange[];
  costUsd: number;
}): GbpSnapshotInsert {
  const { profile } = input;
  return {
    projectId: input.projectId,
    identifier: input.identifier,
    title: profile.title,
    primaryCategory: profile.primaryCategory,
    additionalCategoriesJson: JSON.stringify(profile.additionalCategories),
    website: profile.website,
    phone: profile.phone,
    address: profile.address,
    description: profile.description,
    hoursJson: toJson(profile.hours),
    latitude: profile.latitude,
    longitude: profile.longitude,
    rating: profile.rating,
    reviewCount: profile.reviewCount,
    totalPhotos: profile.totalPhotos,
    isClaimed: profile.isClaimed,
    reviewsJson: toJson(input.reviews),
    updatesJson: toJson(input.updates),
    changesJson: JSON.stringify(input.changes),
    billingCostUsd: input.costUsd,
    capturedAt: input.capturedAt,
  };
}
