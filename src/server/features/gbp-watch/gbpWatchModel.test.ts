import { describe, expect, it } from "vitest";
import profileFixture from "./__fixtures__/sblv-profile.json";
import reviewsFixture from "./__fixtures__/sblv-reviews.json";
import {
  carryForwardOmitted,
  diffProfiles,
  driftFromExpected,
  formatHoursText,
} from "./gbpWatchDiff";
import {
  normalizeProfile,
  normalizeQuestions,
  normalizeReviews,
  normalizeUpdates,
  parseExpected,
  type GbpExpected,
  type GbpProfile,
} from "./gbpWatchModel";

// Fixtures are the 2026-11-03 live pull for SBLV (cid 5590594803775798319),
// trimmed and with reviewer names replaced.
const live = normalizeProfile(profileFixture);
const EVERY_DAY = {
  monday: ["09:00-21:00"],
  tuesday: ["09:00-21:00"],
  wednesday: ["09:00-21:00"],
  thursday: ["09:00-21:00"],
  friday: ["09:00-21:00"],
  saturday: ["09:00-21:00"],
  sunday: ["09:00-21:00"],
};
// Bryan's accepted state, 2026-11-02.
const SBLV_EXPECTED: GbpExpected = {
  primaryCategory: "Photo booth",
  allowedAdditionalCategories: [
    "Balloon artist",
    "Event management company",
    "Event planner",
  ],
  forbiddenCategories: [
    "Wedding service",
    "Photographer",
    "Party equipment rental service",
  ],
  website: "https://socialboothlv.com/",
  hours: EVERY_DAY,
};

const span = (open: number, close: number) => ({
  open: { hour: open, minute: 0 },
  close: { hour: close, minute: 0 },
});

function profile(overrides: Partial<GbpProfile> = {}): GbpProfile {
  return { ...live, ...overrides };
}

describe("normalizeProfile", () => {
  it("reads the live my_business_info item", () => {
    expect(live).toMatchObject({
      title: "Social Booth LV",
      primaryCategory: "Photo booth",
      additionalCategories: [
        "Balloon artist",
        "Event management company",
        "Event planner",
        "Party equipment rental service",
      ],
      website: "https://socialboothlv.com/",
      rating: 5,
      reviewCount: 113,
      isClaimed: true,
      totalPhotos: 115,
      hours: EVERY_DAY,
    });
  });

  it("treats missing hours as null and a day with no spans as closed", () => {
    expect(normalizeProfile({ title: "x" }).hours).toBeNull();
    const hours = normalizeProfile({
      work_time: {
        work_hours: {
          timetable: {
            monday: [
              {
                open: { hour: 9, minute: 0 },
                close: { hour: 17, minute: 30 },
              },
            ],
          },
        },
      },
    }).hours;
    expect(hours?.monday).toEqual(["09:00-17:30"]);
    expect(hours?.sunday).toEqual([]);
  });

  it("sorts a day's time slots", () => {
    const hours = normalizeProfile({
      work_time: {
        work_hours: {
          timetable: { monday: [span(17, 21), span(9, 12)] },
        },
      },
    }).hours;
    expect(hours?.monday).toEqual(["09:00-12:00", "17:00-21:00"]);
  });
});

describe("formatHoursText", () => {
  it("groups runs of identical days", () => {
    expect(formatHoursText(EVERY_DAY)).toBe("Every day 09:00–21:00");
    expect(
      formatHoursText({
        ...EVERY_DAY,
        saturday: ["10:00-14:00"],
        sunday: [],
      }),
    ).toBe("Mon–Fri 09:00–21:00, Sat 10:00–14:00, Sun closed");
    expect(formatHoursText(null)).toBeNull();
  });
});

describe("driftFromExpected", () => {
  it("flags the forbidden party-rental category on the live profile", () => {
    expect(driftFromExpected(live, SBLV_EXPECTED)).toEqual([
      {
        field: "additionalCategories",
        rule: "forbidden_category",
        expected: "Not listed",
        actual: "Party equipment rental service",
      },
    ]);
  });

  it("flags a primary change, an unexpected category, the website and the hours", () => {
    const drift = driftFromExpected(
      profile({
        primaryCategory: "Event management company",
        additionalCategories: ["Photo booth", "DJ service"],
        website: "http://socialboothlv.com",
        hours: { ...EVERY_DAY, sunday: [] },
      }),
      SBLV_EXPECTED,
    );
    expect(drift.map((d) => [d.rule, d.actual])).toEqual([
      ["primary_category", "Event management company"],
      ["unexpected_category", "DJ service"],
      ["website", "http://socialboothlv.com"],
      ["hours", "Mon–Sat 09:00–21:00, Sun closed"],
    ]);
  });

  it("compares websites by scheme, host and path, ignoring utm_* and one trailing slash", () => {
    const site = (website: string) =>
      driftFromExpected(profile({ website }), {
        website: "https://socialboothlv.com/Book",
      }).length;
    expect(
      site("https://SOCIALBOOTHLV.com/Book/?utm_source=gbp&utm_medium=organic"),
    ).toBe(0);
    expect(site("https://socialboothlv.com/book")).toBe(1);
    expect(site("http://socialboothlv.com/Book")).toBe(1);
    expect(site("https://socialboothlv.com/Book?ref=gbp")).toBe(1);
  });

  it("matches categories without case and ignores one trailing slash", () => {
    expect(
      driftFromExpected(
        profile({
          primaryCategory: "photo booth",
          additionalCategories: ["event planner"],
          website: "https://SocialBoothLV.com",
        }),
        SBLV_EXPECTED,
      ),
    ).toEqual([]);
  });

  it("reports nothing when no expectation is set", () => {
    expect(driftFromExpected(live, {})).toEqual([]);
  });
});

describe("diffProfiles", () => {
  const at = "2026-11-09T14:00:00.000Z";

  it("reports watched field changes with display values", () => {
    const next = profile({
      primaryCategory: "Party equipment rental service",
      additionalCategories: ["Photo booth", "Wedding service"],
      hours: { ...EVERY_DAY, sunday: [] },
      website: "http://socialboothlv.com/",
      rating: 4.9,
      reviewCount: 120,
    });
    expect(diffProfiles(live, next, at)).toEqual([
      {
        field: "primaryCategory",
        from: "Photo booth",
        to: "Party equipment rental service",
        detectedAt: at,
      },
      {
        field: "additionalCategories",
        from: "Balloon artist, Event management company, Event planner, Party equipment rental service",
        to: "Photo booth, Wedding service",
        detectedAt: at,
      },
      {
        field: "website",
        from: "https://socialboothlv.com/",
        to: "http://socialboothlv.com/",
        detectedAt: at,
      },
      {
        field: "hours",
        from: "Every day 09:00–21:00",
        to: "Mon–Sat 09:00–21:00, Sun closed",
        detectedAt: at,
      },
    ]);
  });

  it("ignores category order, a trailing slash and phone formatting", () => {
    expect(
      diffProfiles(
        live,
        profile({
          additionalCategories: [
            "Party equipment rental service",
            "Event planner",
            "Event management company",
            "Balloon artist",
          ],
          website: "https://socialboothlv.com",
          phone: "(702) 291-8712",
        }),
        at,
      ),
    ).toEqual([]);
  });
});

describe("carryForwardOmitted", () => {
  const at = "2026-11-09T14:00:00.000Z";

  it("keeps the last hours, claim status and categories when DataForSEO omits them", () => {
    const omitted = profile({
      hours: null,
      isClaimed: null,
      additionalCategories: [],
    });
    const carried = carryForwardOmitted(live, omitted);
    expect(carried).toMatchObject({
      hours: EVERY_DAY,
      isClaimed: true,
      additionalCategories: live.additionalCategories,
    });
    expect(diffProfiles(live, carried, at)).toEqual([]);
  });

  it("keeps a real new value", () => {
    const next = profile({
      hours: { ...EVERY_DAY, sunday: [] },
      isClaimed: false,
    });
    expect(carryForwardOmitted(live, next)).toEqual(next);
  });
});

describe("normalizeReviews", () => {
  it("is a baseline without a previous list: nothing is new", () => {
    const reviews = normalizeReviews(reviewsFixture.items, null);
    expect(reviews).toHaveLength(6);
    expect(reviews[0]).toEqual({
      reviewId: reviewsFixture.items[0]?.review_id,
      author: "Reviewer A",
      rating: 5,
      text: reviewsFixture.items[0]?.review_text,
      publishedAt: "2026-10-29T14:38:59.000Z",
      ownerReplied: false,
      ownerRepliedAt: null,
      isNew: false,
    });
    expect(reviews.some((r) => r.isNew)).toBe(false);
    expect(reviews[1]?.ownerReplied).toBe(true);
  });

  it("marks reviews whose id the previous list did not have", () => {
    const previousIds = new Set(
      reviewsFixture.items.slice(2).map((r) => r.review_id),
    );
    const reviews = normalizeReviews(reviewsFixture.items, previousIds);
    expect(reviews.map((r) => r.isNew)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("normalizeQuestions and normalizeUpdates", () => {
  it("keeps the question text and whether it has an answer", () => {
    expect(
      normalizeQuestions([
        {
          question_id: "q1",
          question_text: "Do you travel to Henderson?",
          profile_name: "Asker",
          timestamp: "2026-10-01 10:00:00 +00:00",
          items: null,
        },
        { question_id: "q2", question_text: "Open late?", items: [{}] },
      ]),
    ).toEqual([
      {
        questionId: "q1",
        text: "Do you travel to Henderson?",
        author: "Asker",
        askedAt: "2026-10-01T10:00:00.000Z",
        answered: false,
      },
      {
        questionId: "q2",
        text: "Open late?",
        author: null,
        askedAt: null,
        answered: true,
      },
    ]);
  });

  it("marks owner posts that were not in the previous list", () => {
    const rows = [
      {
        url: "https://posts/2",
        post_text: "Holiday party season",
        timestamp: "2026-11-05 18:00:00 +00:00",
      },
      {
        url: "https://posts/1",
        post_text: "Trade show recap",
        timestamp: "2026-10-01 18:00:00 +00:00",
      },
    ];
    expect(
      normalizeUpdates(rows, new Set(["https://posts/1"])).map((u) => [
        u.key,
        u.isNew,
      ]),
    ).toEqual([
      ["https://posts/2", true],
      ["https://posts/1", false],
    ]);
  });
});

describe("parseExpected", () => {
  it("drops a malformed stored value instead of throwing", () => {
    expect(parseExpected("not json")).toEqual({});
    expect(parseExpected('{"primaryCategory": 3}')).toEqual({});
    expect(parseExpected(JSON.stringify(SBLV_EXPECTED))).toEqual(SBLV_EXPECTED);
  });
});
