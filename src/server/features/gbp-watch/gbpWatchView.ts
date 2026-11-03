import { sort } from "remeda";
import type {
  GbpConfig,
  GbpSnapshotRow,
} from "@/server/features/gbp-watch/repositories/GbpWatchRepository";
import { toIsoTimestamp } from "@/server/features/public-api/timestamps";
import {
  profileFromRow,
  sameProfileRun,
  readChanges,
  readReviews,
  readUpdates,
} from "./gbpSnapshotCodec";
import { driftFromExpected, driftKey, formatHoursText } from "./gbpWatchDiff";
import {
  parseExpected,
  type GbpChange,
  type GbpDrift,
  type GbpHours,
  type GbpReview,
} from "./gbpWatchModel";

/**
 * CLIENT-SBLV-193: the read model behind `get_gbp_watch` and the public
 * summary's `gbp` section, built from stored rows only (never metered).
 */

export const GBP_VIEW_SNAPSHOT_LIMIT = 30;
const CHANGES_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_CHANGES = 20;
const LATEST_REVIEWS = 5;
const RECENT_UPDATES = 3;

export type GbpWatchView = {
  tracked: boolean;
  placeId: string | null;
  cid: string | null;
  listingId: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  lastError: string | null;
  profile: {
    capturedAt: string | null;
    title: string | null;
    primaryCategory: string | null;
    additionalCategories: string[];
    website: string | null;
    phone: string | null;
    address: string | null;
    hours: GbpHours | null;
    hoursText: string | null;
    isClaimed: boolean | null;
    totalPhotos: number | null;
    mapsUrl: string | null;
  } | null;
  rating: {
    value: number | null;
    reviewCount: number | null;
    previousValue: number | null;
    previousReviewCount: number | null;
    valueChange: number | null;
    reviewCountChange: number | null;
    comparedTo: string | null;
  };
  latestReviews: GbpReview[];
  /** New in the latest check; null when that check did not collect reviews. */
  newReviewCount: number | null;
  ownerUpdates: {
    latestPostedAt: string | null;
    newCount: number;
    recent: {
      postedAt: string | null;
      text: string | null;
      url: string | null;
    }[];
  } | null;
  changes: GbpChange[];
  driftFromExpected: (GbpDrift & { since: string | null })[];
};

const diff = (a: number | null, b: number | null) =>
  a === null || b === null ? null : Math.round((a - b) * 100) / 100;

function mapsUrl(config: GbpConfig | null): string | null {
  if (config?.cid) return `https://www.google.com/maps?cid=${config.cid}`;
  if (config?.placeId)
    return `https://www.google.com/maps/place/?q=place_id:${config.placeId}`;
  return null;
}

/** Each latest finding, with the capturedAt of the first snapshot in its unbroken run. */
function driftWithSince(
  rows: GbpSnapshotRow[],
  config: GbpConfig | null,
): GbpWatchView["driftFromExpected"] {
  const expected = parseExpected(config?.expectedJson);
  const [latest] = rows;
  if (!latest) return [];
  const perRow = rows.map(
    (row) =>
      new Set(driftFromExpected(profileFromRow(row), expected).map(driftKey)),
  );
  return driftFromExpected(profileFromRow(latest), expected).map((item) => {
    const key = driftKey(item);
    // Walk back while each older snapshot still shows the same finding.
    let since = latest.capturedAt;
    for (const [i, row] of rows.entries()) {
      if (!perRow[i]?.has(key)) break;
      since = row.capturedAt;
    }
    return { ...item, since: toIsoTimestamp(since) };
  });
}

function recentChanges(rows: GbpSnapshotRow[], now: Date): GbpChange[] {
  const cutoff = now.getTime() - CHANGES_WINDOW_MS;
  const all = rows
    .flatMap(readChanges)
    .map((change) => ({
      ...change,
      detectedAt: toIsoTimestamp(change.detectedAt) ?? change.detectedAt,
    }))
    .filter((change) => Date.parse(change.detectedAt) >= cutoff);
  return sort(all, (a, b) => b.detectedAt.localeCompare(a.detectedAt)).slice(
    0,
    MAX_CHANGES,
  );
}

function profileView(
  latest: GbpSnapshotRow | undefined,
  config: GbpConfig | null,
): GbpWatchView["profile"] {
  if (!latest) return null;
  const profile = profileFromRow(latest);
  return {
    capturedAt: toIsoTimestamp(latest.capturedAt),
    title: profile.title,
    primaryCategory: profile.primaryCategory,
    additionalCategories: profile.additionalCategories,
    website: profile.website,
    phone: profile.phone,
    address: profile.address,
    hours: profile.hours,
    hoursText: formatHoursText(profile.hours),
    isClaimed: profile.isClaimed,
    totalPhotos: profile.totalPhotos,
    mapsUrl: mapsUrl(config),
  };
}

function ratingView(
  latest: GbpSnapshotRow | undefined,
  previous: GbpSnapshotRow | undefined,
): GbpWatchView["rating"] {
  const value = latest?.rating ?? null;
  const reviewCount = latest?.reviewCount ?? null;
  const previousValue = previous?.rating ?? null;
  const previousReviewCount = previous?.reviewCount ?? null;
  return {
    value,
    reviewCount,
    previousValue,
    previousReviewCount,
    valueChange: diff(value, previousValue),
    reviewCountChange: diff(reviewCount, previousReviewCount),
    comparedTo: toIsoTimestamp(previous?.capturedAt),
  };
}

function updatesView(rows: GbpSnapshotRow[]): GbpWatchView["ownerUpdates"] {
  const updates = rows.map(readUpdates).find((list) => list !== null);
  if (!updates) return null;
  const newest = sort(updates, (a, b) =>
    (b.postedAt ?? "").localeCompare(a.postedAt ?? ""),
  );
  return {
    latestPostedAt: newest[0]?.postedAt ?? null,
    newCount: newest.filter((update) => update.isNew).length,
    recent: newest
      .slice(0, RECENT_UPDATES)
      .map(({ postedAt, text, url }) => ({ postedAt, text, url })),
  };
}

/** `rows` newest first (GbpWatchRepository.listRecentSnapshots). */
export function buildGbpWatchView(
  config: GbpConfig | null,
  allRows: GbpSnapshotRow[],
  now: Date,
): GbpWatchView {
  // Rows about an earlier cid / place_id are a different baseline.
  const rows = sameProfileRun(allRows);
  const [latest, previous] = rows;
  // Lists come from the newest snapshot that collected them.
  // "New" belongs to the latest check only. When it missed reviews, the list
  // falls back to an older check with its "new" flags cleared.
  const latestReviewList = latest ? readReviews(latest) : null;
  const reviews =
    latestReviewList ??
    (rows.map(readReviews).find((list) => list !== null) ?? []).map(
      (review) => ({ ...review, isNew: false }),
    );

  return {
    tracked: config?.isActive ?? false,
    placeId: config?.placeId ?? null,
    cid: config?.cid ?? null,
    listingId: config?.listingId ?? null,
    lastCheckedAt: toIsoTimestamp(config?.lastCheckedAt),
    nextCheckAt: toIsoTimestamp(config?.nextCheckAt),
    lastError: config?.lastError ?? null,
    profile: profileView(latest, config),
    rating: ratingView(latest, previous),
    latestReviews: sort(reviews, (a, b) =>
      (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
    ).slice(0, LATEST_REVIEWS),
    newReviewCount: latestReviewList
      ? latestReviewList.filter((review) => review.isNew).length
      : null,
    ownerUpdates: updatesView(rows),
    changes: recentChanges(rows, now),
    driftFromExpected: driftWithSince(rows, config),
  };
}
