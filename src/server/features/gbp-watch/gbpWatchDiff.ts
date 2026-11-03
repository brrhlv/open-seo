import {
  GBP_WATCHED_FIELDS,
  GBP_WEEKDAYS,
  type GbpChange,
  type GbpDrift,
  type GbpExpected,
  type GbpField,
  type GbpHours,
  type GbpProfile,
  type Weekday,
} from "./gbpWatchModel";

/**
 * CLIENT-SBLV-193: compares GBP snapshots with each other (`changes`) and
 * with the project's accepted state (`driftFromExpected`). Pure.
 */

const DAY_SHORT: Record<Weekday, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

function spansText(spans: string[]): string {
  return spans.length === 0
    ? "closed"
    : spans.map((span) => span.replace("-", "–")).join(", ");
}

/** "Every day 09:00–21:00" or "Mon–Fri 09:00–17:00, Sat–Sun closed". */
export function formatHoursText(hours: GbpHours | null): string | null {
  if (!hours) return null;
  const runs: { from: Weekday; to: Weekday; text: string }[] = [];
  for (const day of GBP_WEEKDAYS) {
    const text = spansText(hours[day]);
    const last = runs.at(-1);
    if (last && last.text === text) last.to = day;
    else runs.push({ from: day, to: day, text });
  }
  if (runs.length === 1) return `Every day ${runs[0]?.text ?? ""}`;
  return runs
    .map(
      (run) =>
        `${DAY_SHORT[run.from]}${run.to === run.from ? "" : `–${DAY_SHORT[run.to]}`} ${run.text}`,
    )
    .join(", ");
}

const categoryKey = (name: string) => name.trim().toLowerCase();

function sameCategories(a: string[], b: string[]): boolean {
  const left = new Set(a.map(categoryKey));
  const right = new Set(b.map(categoryKey));
  return left.size === right.size && [...left].every((c) => right.has(c));
}

/** Lowercased, one trailing slash dropped. The scheme is kept on purpose. */
function websiteKey(url: string | null): string | null {
  return url ? url.trim().toLowerCase().replace(/\/+$/, "") : null;
}

function sameHours(a: GbpHours | null, b: GbpHours | null): boolean {
  if (a === null || b === null) return a === b;
  return GBP_WEEKDAYS.every(
    (day) => (a[day] ?? []).join(",") === (b[day] ?? []).join(","),
  );
}

type FieldRule = {
  same: (a: GbpProfile, b: GbpProfile) => boolean;
  show: (p: GbpProfile) => string | null;
};

const yesNo = (value: boolean | null) =>
  value === null ? null : value ? "yes" : "no";
// The national number: Google shows "+1702-291-8712" where a person types
// "(702) 291-8712".
const digits = (value: string | null) =>
  value?.replace(/\D/g, "").slice(-10) ?? null;

const FIELD_RULES: Record<GbpField, FieldRule> = {
  title: { same: (a, b) => a.title === b.title, show: (p) => p.title },
  primaryCategory: {
    same: (a, b) =>
      (a.primaryCategory ? categoryKey(a.primaryCategory) : null) ===
      (b.primaryCategory ? categoryKey(b.primaryCategory) : null),
    show: (p) => p.primaryCategory,
  },
  additionalCategories: {
    same: (a, b) =>
      sameCategories(a.additionalCategories, b.additionalCategories),
    show: (p) =>
      p.additionalCategories.length ? p.additionalCategories.join(", ") : null,
  },
  website: {
    same: (a, b) => websiteKey(a.website) === websiteKey(b.website),
    show: (p) => p.website,
  },
  phone: {
    same: (a, b) => digits(a.phone) === digits(b.phone),
    show: (p) => p.phone,
  },
  address: { same: (a, b) => a.address === b.address, show: (p) => p.address },
  hours: {
    same: (a, b) => sameHours(a.hours, b.hours),
    show: (p) => formatHoursText(p.hours),
  },
  isClaimed: {
    same: (a, b) => a.isClaimed === b.isClaimed,
    show: (p) => yesNo(p.isClaimed),
  },
};

/** Watched fields that differ between two snapshots, in GBP_WATCHED_FIELDS order. */
export function diffProfiles(
  previous: GbpProfile,
  next: GbpProfile,
  detectedAt: string,
): GbpChange[] {
  return GBP_WATCHED_FIELDS.flatMap((field) => {
    const rule = FIELD_RULES[field];
    if (rule.same(previous, next)) return [];
    return [
      { field, from: rule.show(previous), to: rule.show(next), detectedAt },
    ];
  });
}

/** How the profile differs from the accepted state. Empty when it matches. */
export function driftFromExpected(
  profile: GbpProfile,
  expected: GbpExpected,
): GbpDrift[] {
  const drift: GbpDrift[] = [];
  const forbidden = new Set(
    (expected.forbiddenCategories ?? []).map(categoryKey),
  );
  const allowed = expected.allowedAdditionalCategories
    ? new Set(expected.allowedAdditionalCategories.map(categoryKey))
    : null;
  const expectedPrimary = expected.primaryCategory
    ? categoryKey(expected.primaryCategory)
    : null;
  const primary = profile.primaryCategory
    ? categoryKey(profile.primaryCategory)
    : null;

  const primaryMismatch =
    expectedPrimary !== null && primary !== expectedPrimary;
  if (primaryMismatch) {
    drift.push({
      field: "primaryCategory",
      rule: "primary_category",
      expected: expected.primaryCategory ?? null,
      actual: profile.primaryCategory,
    });
  }
  if (!primaryMismatch && primary !== null && forbidden.has(primary)) {
    drift.push({
      field: "primaryCategory",
      rule: "forbidden_category",
      expected: "Not listed",
      actual: profile.primaryCategory,
    });
  }
  for (const category of profile.additionalCategories) {
    const key = categoryKey(category);
    if (forbidden.has(key)) {
      drift.push({
        field: "additionalCategories",
        rule: "forbidden_category",
        expected: "Not listed",
        actual: category,
      });
    } else if (allowed && !allowed.has(key) && key !== expectedPrimary) {
      drift.push({
        field: "additionalCategories",
        rule: "unexpected_category",
        expected: expected.allowedAdditionalCategories?.join(", ") || null,
        actual: category,
      });
    }
  }
  if (
    expected.website &&
    websiteKey(expected.website) !== websiteKey(profile.website)
  ) {
    drift.push({
      field: "website",
      rule: "website",
      expected: expected.website,
      actual: profile.website,
    });
  }
  if (expected.hours && !sameHours(expected.hours, profile.hours)) {
    drift.push({
      field: "hours",
      rule: "hours",
      expected: formatHoursText(expected.hours),
      actual: formatHoursText(profile.hours),
    });
  }
  return drift;
}

/** Identity of a drift finding across snapshots (for its `since`). */
export function driftKey(item: GbpDrift): string {
  return `${item.rule}:${(item.actual ?? "").toLowerCase()}`;
}
