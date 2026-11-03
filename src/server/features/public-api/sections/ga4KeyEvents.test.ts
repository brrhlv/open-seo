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
/** byEvent = all channels with the previous period; byPage and landing = organic. */
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

const lead = (landingPage: string, keyEvents: number) => ({
  eventName: "generate_lead",
  hostName: "a.com",
  landingPage,
  keyEvents,
});

describe("getGa4KeyEventsSection", () => {
  beforeEach(() => {
    reports(
      [
        comparisonRow("generate_lead", 7, 2),
        comparisonRow("phone_click", 0, 6),
      ],
      [
        lead("/corporate-events/", 2),
        lead("/deep", 1),
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
          sessions: 30,
          keyEvents: 0,
          sessionKeyEventRate: 0,
        },
        // www and bare host for the same path are one page.
        {
          hostName: "www.a.com",
          landingPage: "/",
          sessions: 10,
          keyEvents: 1,
          sessionKeyEventRate: 0.1,
        },
        {
          hostName: "a.com",
          landingPage: "/corporate-events",
          sessions: 21,
          keyEvents: 2,
          sessionKeyEventRate: 0.095,
        },
        { hostName: "a.com", landingPage: "(not set)", sessions: 3 },
      ],
    );
  });

  it("compares events across all channels; pages stay organic", async () => {
    await getGa4KeyEventsSection("p", DATES, NOW);
    expect(mocks.runReport).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "key_events",
        breakdown: "event",
        comparePreviousPeriod: true,
        channel: "all",
        startDate: DATES.start,
        endDate: DATES.end,
      }),
    );
    expect(mocks.runReport).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "landing_pages",
        channel: "organic_search",
      }),
    );
  });

  it("merges events into organic landing pages, www and bare host as one, and flags a silent event", async () => {
    const section = await getGa4KeyEventsSection("p", DATES, NOW);
    expect(section.events).toEqual([
      {
        eventName: "generate_lead",
        keyEvents: 7,
        previousKeyEvents: 2,
        organicKeyEvents: 3,
      },
      {
        eventName: "phone_click",
        keyEvents: 0,
        previousKeyEvents: 6,
        organicKeyEvents: 1,
      },
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
        keyEvents: 1,
        keyEventRate: 0.025,
        events: [],
      },
    ]);
    expect(section.capturedAt).toBe(NOW.toISOString());
  });

  it("does not call a low-volume event silent", async () => {
    reports([comparisonRow("phone_click", 0, 4)], [], []);
    const section = await getGa4KeyEventsSection("p", DATES, NOW);
    expect(section.tracking.status).not.toBe("silent");
  });

  it("says when no key event counted on any channel", async () => {
    reports([], [], []);
    const section = await getGa4KeyEventsSection("p", DATES, NOW);
    expect(section.tracking).toEqual({
      status: "no_key_events",
      silentEvents: [],
    });
  });

  it("says when key events count, just not from organic search", async () => {
    reports([comparisonRow("generate_lead", 4, 3)], [], []);
    const section = await getGa4KeyEventsSection("p", DATES, NOW);
    expect(section.tracking).toEqual({
      status: "no_organic_key_events",
      silentEvents: [],
    });
  });
});
