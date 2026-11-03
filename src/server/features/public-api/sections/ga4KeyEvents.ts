import { sortBy } from "remeda";
import { Ga4ReportingService } from "@/server/features/ga4/services/Ga4ReportingService";

// CLIENT-SBLV-194: key events for the summary range. Per event across ALL
// channels with the previous period (broken tracking silences every channel,
// so that is where it shows), and per ORGANIC landing page (conversions by
// landing page). Three free GA4 Data API calls, run beside the ga4 section.

const LANDING_PAGE_LIMIT = 25;
const REPORT_ROW_LIMIT = 250;
// An event needs this many key events last period before "none now" means
// its tracking broke rather than an ordinary quiet month.
const SILENT_MIN_PREVIOUS = 5;

type Ga4Row = Record<string, string | number | null>;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** "host + path", host without www, path without a trailing slash: the join
 *  key across reports, so www and bare-host visits to a page are one row. */
function pageKey(row: Ga4Row): string | null {
  const landing = text(row.landingPage);
  if (!landing || landing === "(not set)") return null;
  const path = landing.split("?")[0] ?? "";
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const host = text(row.hostName)
    .toLowerCase()
    .replace(/^www\./, "");
  return `${host}${trimmed || "/"}`;
}

type LandingPage = {
  page: string;
  sessions: number;
  keyEvents: number;
  keyEventRate: number;
  events: { eventName: string; keyEvents: number }[];
};

export async function getGa4KeyEventsSection(
  projectId: string,
  dates: { start: string; end: string },
  now: Date,
) {
  const common = { projectId, startDate: dates.start, endDate: dates.end };
  const [byEvent, byEventAndPage, landingPages] = await Promise.all([
    Ga4ReportingService.runReport({
      ...common,
      channel: "all",
      kind: "key_events",
      breakdown: "event",
      comparePreviousPeriod: true,
      limit: REPORT_ROW_LIMIT,
    }),
    Ga4ReportingService.runReport({
      ...common,
      channel: "organic_search",
      kind: "key_events",
      breakdown: "event_and_landing_page",
      limit: REPORT_ROW_LIMIT,
    }),
    Ga4ReportingService.runReport({
      ...common,
      channel: "organic_search",
      kind: "landing_pages",
      limit: REPORT_ROW_LIMIT,
    }),
  ]);

  const organicByEvent = new Map<string, number>();
  for (const row of byEventAndPage.rows) {
    const name = text(row.eventName);
    organicByEvent.set(
      name,
      (organicByEvent.get(name) ?? 0) + num(row.keyEvents),
    );
  }
  const events = sortBy(
    (byEvent.comparison?.rows ?? []).map((row) => {
      const eventName = text(row.dimensions.eventName);
      return {
        eventName,
        keyEvents: num(row.metrics.keyEvents?.current),
        previousKeyEvents:
          row.metrics.keyEvents?.previous == null
            ? null
            : num(row.metrics.keyEvents.previous),
        organicKeyEvents: organicByEvent.get(eventName) ?? 0,
      };
    }),
    [(event) => event.keyEvents, "desc"],
    (event) => event.eventName,
  );
  const silentEvents = events
    .filter(
      (event) =>
        event.keyEvents === 0 &&
        (event.previousKeyEvents ?? 0) >= SILENT_MIN_PREVIOUS,
    )
    .map((event) => event.eventName);

  const pages = new Map<string, LandingPage>();
  for (const row of landingPages.rows) {
    const key = pageKey(row);
    if (!key) continue;
    const sessions = num(row.sessions);
    const existing = pages.get(key);
    if (!existing) {
      pages.set(key, {
        page: key,
        sessions,
        keyEvents: num(row.keyEvents),
        keyEventRate: num(row.sessionKeyEventRate),
        events: [],
      });
      continue;
    }
    // Same page on www and bare host: add up, rate weighted by sessions.
    const total = existing.sessions + sessions;
    existing.keyEventRate =
      total > 0
        ? (existing.keyEventRate * existing.sessions +
            num(row.sessionKeyEventRate) * sessions) /
          total
        : 0;
    existing.sessions = total;
    existing.keyEvents += num(row.keyEvents);
  }
  const landingKeys = new Set(pages.keys());
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
    const eventName = text(row.eventName);
    const same = entry.events.find((e) => e.eventName === eventName);
    if (same) same.keyEvents += num(row.keyEvents);
    else entry.events.push({ eventName, keyEvents: num(row.keyEvents) });
    pages.set(key, entry);
  }
  // A page past the landing-page report's row limit has events only.
  for (const [key, entry] of pages) {
    if (!landingKeys.has(key)) {
      entry.keyEvents = entry.events.reduce((sum, e) => sum + e.keyEvents, 0);
    }
  }

  const organicTotal = [...organicByEvent.values()].reduce((a, b) => a + b, 0);
  let status: "ok" | "silent" | "no_key_events" | "no_organic_key_events" =
    "ok";
  if (events.length === 0) status = "no_key_events";
  else if (silentEvents.length > 0) status = "silent";
  else if (organicTotal === 0) status = "no_organic_key_events";

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
    tracking: { status, silentEvents },
  };
}
