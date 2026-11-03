import { sortBy } from "remeda";
import { Ga4ReportingService } from "@/server/features/ga4/services/Ga4ReportingService";

// CLIENT-SBLV-194: organic key events for the summary range — per event with
// the previous period (to spot tracking that went silent) and per organic
// landing page (conversions by landing page). Three free GA4 Data API calls,
// run beside the rest of the ga4 section.

const LANDING_PAGE_LIMIT = 25;
const REPORT_ROW_LIMIT = 250;

type Ga4Row = Record<string, string | number | null>;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** "host + path" without a trailing slash, the join key across reports. */
function pageKey(row: Ga4Row): string | null {
  const landing = text(row.landingPage);
  if (!landing || landing === "(not set)") return null;
  const path = landing.split("?")[0] ?? "";
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return `${text(row.hostName).toLowerCase()}${trimmed || "/"}`;
}

export async function getGa4KeyEventsSection(
  projectId: string,
  dates: { start: string; end: string },
  now: Date,
) {
  const common = {
    projectId,
    startDate: dates.start,
    endDate: dates.end,
    channel: "organic_search" as const,
  };
  const [byEvent, byEventAndPage, landingPages] = await Promise.all([
    Ga4ReportingService.runReport({
      ...common,
      kind: "key_events",
      breakdown: "event",
      comparePreviousPeriod: true,
      limit: REPORT_ROW_LIMIT,
    }),
    Ga4ReportingService.runReport({
      ...common,
      kind: "key_events",
      breakdown: "event_and_landing_page",
      limit: REPORT_ROW_LIMIT,
    }),
    Ga4ReportingService.runReport({
      ...common,
      kind: "landing_pages",
      limit: REPORT_ROW_LIMIT,
    }),
  ]);

  const events = sortBy(
    (byEvent.comparison?.rows ?? []).map((row) => ({
      eventName: text(row.dimensions.eventName),
      keyEvents: num(row.metrics.keyEvents?.current),
      previousKeyEvents:
        row.metrics.keyEvents?.previous == null
          ? null
          : num(row.metrics.keyEvents.previous),
    })),
    [(event) => event.keyEvents, "desc"],
    (event) => event.eventName,
  );
  const silentEvents = events
    .filter(
      (event) => event.keyEvents === 0 && (event.previousKeyEvents ?? 0) > 0,
    )
    .map((event) => event.eventName);

  const pages = new Map<
    string,
    {
      page: string;
      sessions: number;
      keyEvents: number;
      keyEventRate: number;
      events: { eventName: string; keyEvents: number }[];
    }
  >();
  for (const row of landingPages.rows) {
    const key = pageKey(row);
    if (!key) continue;
    pages.set(key, {
      page: key,
      sessions: num(row.sessions),
      keyEvents: num(row.keyEvents),
      keyEventRate: num(row.sessionKeyEventRate),
      events: [],
    });
  }
  for (const row of byEventAndPage.rows) {
    const key = pageKey(row);
    if (!key) continue;
    const entry = pages.get(key) ?? {
      page: key,
      sessions: 0,
      keyEvents: 0,
      keyEventRate: 0,
      events: [],
    };
    entry.events.push({
      eventName: text(row.eventName),
      keyEvents: num(row.keyEvents),
    });
    pages.set(key, entry);
  }
  // A page past the landing-page report's row limit has events only.
  const landingKeys = new Set(landingPages.rows.map(pageKey));
  for (const [key, entry] of pages) {
    if (!landingKeys.has(key)) {
      entry.keyEvents = entry.events.reduce((sum, e) => sum + e.keyEvents, 0);
    }
  }

  return {
    capturedAt: now.toISOString(),
    dateRange: byEvent.request.resolvedDateRange,
    events,
    landingPages: sortBy(
      [...pages.values()],
      [(page) => page.keyEvents, "desc"],
      [(page) => page.sessions, "desc"],
      (page) => page.page,
    )
      .slice(0, LANDING_PAGE_LIMIT)
      .map((page) => ({
        ...page,
        events: sortBy(page.events, [(e) => e.keyEvents, "desc"]),
      })),
    tracking: {
      status:
        events.length === 0
          ? ("no_key_events" as const)
          : silentEvents.length > 0
            ? ("silent" as const)
            : ("ok" as const),
      silentEvents,
    },
  };
}
