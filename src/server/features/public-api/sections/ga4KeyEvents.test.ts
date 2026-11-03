import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGa4KeyEventsSection } from "./ga4KeyEvents";

const mocks = vi.hoisted(() => ({ runReport: vi.fn() }));
vi.mock("@/server/features/ga4/services/Ga4ReportingService", () => ({
  Ga4ReportingService: { runReport: mocks.runReport },
}));

const NOW = new Date("2026-11-02T18:00:00.000Z");
const DATES = { start: "2026-10-03", end: "2026-10-30" };

function comparisonRow(
  eventName: string,
  current: number,
  previous: number | null,
) {
  return {
    dimensions: { eventName },
    metrics: { keyEvents: { current, previous } },
  };
}

type Input = { kind: string; breakdown?: string };
function reports(byEvent: unknown[], byPage: unknown[], landing: unknown[]) {
  mocks.runReport.mockImplementation((input: Input) =>
    Promise.resolve(
      input.kind === "landing_pages"
        ? { rows: landing }
        : input.breakdown === "event_and_landing_page"
          ? { rows: byPage }
          : {
              rows: [],
              request: {
                resolvedDateRange: {
                  startDate: DATES.start,
                  endDate: DATES.end,
                },
              },
              comparison: { rows: byEvent },
            },
    ),
  );
}

describe("getGa4KeyEventsSection", () => {
  beforeEach(() => {
    reports(
      [
        comparisonRow("generate_lead", 5, 0),
        comparisonRow("phone_click", 0, 3),
      ],
      [
        {
          eventName: "generate_lead",
          hostName: "a.com",
          landingPage: "/corporate-events/",
          keyEvents: 2,
        },
        {
          eventName: "generate_lead",
          hostName: "a.com",
          landingPage: "/deep",
          keyEvents: 1,
        },
        {
          eventName: "phone_click",
          hostName: "a.com",
          landingPage: "/deep?utm=x",
          keyEvents: 1,
        },
      ],
      [
        {
          hostName: "a.com",
          landingPage: "/",
          sessions: 40,
          keyEvents: 0,
          sessionKeyEventRate: 0,
        },
        {
          hostName: "a.com",
          landingPage: "/corporate-events",
          sessions: 21,
          keyEvents: 2,
          sessionKeyEventRate: 0.095,
        },
        {
          hostName: "a.com",
          landingPage: "(not set)",
          sessions: 3,
          keyEvents: 0,
        },
      ],
    );
  });

  it("asks GA4 for organic key events in the summary range", async () => {
    await getGa4KeyEventsSection("p", DATES, NOW);
    expect(mocks.runReport).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "key_events",
        breakdown: "event",
        comparePreviousPeriod: true,
        channel: "organic_search",
        startDate: DATES.start,
        endDate: DATES.end,
      }),
    );
  });

  it("merges events into landing pages, most key events first, and flags silent events", async () => {
    const section = await getGa4KeyEventsSection("p", DATES, NOW);
    expect(section.events).toEqual([
      { eventName: "generate_lead", keyEvents: 5, previousKeyEvents: 0 },
      { eventName: "phone_click", keyEvents: 0, previousKeyEvents: 3 },
    ]);
    expect(section.tracking).toEqual({
      status: "silent",
      silentEvents: ["phone_click"],
    });
    expect(section.landingPages).toEqual([
      {
        page: "a.com/corporate-events",
        sessions: 21,
        keyEvents: 2,
        keyEventRate: 0.095,
        events: [{ eventName: "generate_lead", keyEvents: 2 }],
      },
      {
        page: "a.com/deep",
        sessions: 0,
        keyEvents: 2,
        keyEventRate: 0,
        events: [
          { eventName: "generate_lead", keyEvents: 1 },
          { eventName: "phone_click", keyEvents: 1 },
        ],
      },
      {
        page: "a.com/",
        sessions: 40,
        keyEvents: 0,
        keyEventRate: 0,
        events: [],
      },
    ]);
    expect(section.capturedAt).toBe(NOW.toISOString());
  });

  it("says when the property has no key events at all", async () => {
    reports([], [], []);
    const section = await getGa4KeyEventsSection("p", DATES, NOW);
    expect(section.tracking).toEqual({
      status: "no_key_events",
      silentEvents: [],
    });
  });
});
