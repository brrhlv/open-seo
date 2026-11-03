import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
}));

import {
  fetchLiveSerp,
  fetchRankCheckTaskResult,
  postRankCheckTasks,
} from "@/server/lib/dataforseo/serp";

function parseDataforseoRequestBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected DataForSEO request body to be a string");
  }
  return JSON.parse(body) as unknown;
}

describe("live SERP", () => {
  // 40102 is the documented "No Search Results." code (40501 is "Invalid
  // Field."). isNoResultsTask matches on the status message, not the code, so
  // this stays correct whichever code DataForSEO attaches to the message.
  it("returns an empty result for DataForSEO's no-results task", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          status_code: 20000,
          tasks: [
            {
              status_code: 40102,
              status_message: "No Search Results.",
              path: ["v3", "serp", "google", "organic", "live", "advanced"],
              cost: 0.002,
              result_count: 0,
              result: [],
            },
          ],
        }),
      ),
    );

    await expect(
      fetchLiveSerp({
        keyword: "obscure query",
        locationCode: 2840,
        languageCode: "en",
      }),
    ).resolves.toMatchObject({
      data: [],
      billing: { costUsd: 0.002 },
    });
  });
});

describe("rank check task queue", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts queued tasks, maps ids by tag, and sums cost over all entries", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [
          {
            id: "task-a",
            status_code: 20100,
            cost: 0.0006,
            data: { tag: "kw-1:desktop" },
          },
          {
            id: "task-b",
            status_code: 20100,
            cost: 0.0006,
            data: { tag: "kw-1:mobile" },
          },
          {
            id: "task-c",
            status_code: 40006,
            status_message: "Task Limit Exceeded",
            cost: 0.0006,
            data: { tag: "kw-2:desktop" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await postRankCheckTasks({
      tasks: [
        { keyword: "alpha", keywordId: "kw-1", device: "desktop" },
        { keyword: "alpha", keywordId: "kw-1", device: "mobile" },
        { keyword: "beta", keywordId: "kw-2", device: "desktop" },
      ],
      locationCode: 2840,
      languageCode: "en",
      depth: 20,
      targetDomain: "example.com",
    });

    expect(
      fetchMock.mock.calls.map(([url]) =>
        typeof url === "string" || url instanceof URL
          ? url.toString()
          : url.url,
      ),
    ).toEqual(["https://api.dataforseo.com/v3/serp/google/organic/task_post"]);

    // Every posted task asks DataForSEO to stop crawling at the target's
    // organic listing — that is what cuts the actual crawl cost for ranking
    // domains without false "not ranking" stops on sitelinks/PAA mentions.
    const stopCrawl = {
      stop_crawl_on_match: [
        { match_value: "example.com", match_type: "with_subdomains" },
      ],
      find_targets_in: ["organic"],
    };
    expect(
      parseDataforseoRequestBody(fetchMock.mock.calls[0]?.[1]),
    ).toMatchObject([stopCrawl, stopCrawl, stopCrawl]);
    expect(result.data).toEqual([
      {
        keyword: "alpha",
        keywordId: "kw-1",
        device: "desktop",
        taskId: "task-a",
      },
      {
        keyword: "alpha",
        keywordId: "kw-1",
        device: "mobile",
        taskId: "task-b",
      },
    ]);
    // The rejected entry's cost is still metered: a charge is a charge.
    expect(result.billing.costUsd).toBeCloseTo(0.0018, 10);
    expect(result.billing.path).toEqual([
      "v3",
      "serp",
      "google",
      "organic",
      "task_post",
    ]);
  });

  it("reports a queued task still in progress as pending", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [{ id: "task-a", status_code: 40602 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
    });

    expect(outcome).toEqual({ status: "pending" });
  });

  it("parses a completed queued task into a rank check result", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [
          {
            id: "task-a",
            status_code: 20000,
            cost: 0,
            path: ["v3", "serp", "google", "organic", "task_get", "advanced"],
            result: [
              {
                items: [
                  {
                    type: "organic",
                    rank_group: 3,
                    rank_absolute: 4,
                    domain: "www.example.com",
                    url: "https://www.example.com/page",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
    });

    expect(outcome).toEqual({
      status: "completed",
      result: {
        keywordId: "kw-1",
        keyword: "alpha",
        position: 3,
        url: "https://www.example.com/page",
        serpFeatures: ["organic"],
      },
    });
  });
});

// Mobile SERPs wrap many organic results in a Google redirect: domain
// google.com, a google.com/goto URL, and the real site only in the breadcrumb.
// Items below are trimmed from real mobile Las Vegas responses (SBLV-188).
const GOTO_URL = "https://google.com/goto?url=CAESeAHrOzAVxvNGtZoPcNHU";

function gotoItem(rankGroup: number, breadcrumb: string) {
  return {
    type: "organic",
    rank_group: rankGroup,
    domain: "google.com",
    url: GOTO_URL,
    breadcrumb,
  };
}

async function checkRank(items: unknown[], targetDomain: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [
          {
            id: "task-a",
            status_code: 20000,
            cost: 0,
            path: ["v3", "serp", "google", "organic", "task_get", "advanced"],
            result: [{ items }],
          },
        ],
      }),
    ),
  );
  const outcome = await fetchRankCheckTaskResult({
    taskId: "task-a",
    keywordId: "kw-1",
    keyword: "photo booth las vegas",
    targetDomain,
  });
  if (outcome.status !== "completed") throw new Error(outcome.status);
  return { position: outcome.result.position, url: outcome.result.url };
}

describe("rank check on goto-wrapped mobile results", () => {
  it("matches a goto result through its breadcrumb host", async () => {
    // holiday party photo booth las vegas: socialboothlv.com is #15.
    const result = await checkRank(
      [
        {
          type: "organic",
          rank_group: 1,
          domain: "www.shutterboxphotobooth.com",
          url: "https://www.shutterboxphotobooth.com/locations/las-vegas/",
          breadcrumb: "https://www.shutterboxphotobooth.com",
        },
        gotoItem(2, "https://www.funphotoboothlv.com"),
        gotoItem(3, "4 days ago"),
        gotoItem(15, "https://socialboothlv.com"),
      ],
      "socialboothlv.com",
    );

    expect(result).toEqual({ position: 15, url: "https://socialboothlv.com/" });
  });

  it("does not match a lookalike domain", async () => {
    // trade show photo booth las vegas, without the real #17 listing.
    const result = await checkRank(
      [
        gotoItem(12, "1.4K+ followers"),
        {
          type: "organic",
          rank_group: 20,
          domain: "thesocialboothco.com",
          url: "https://thesocialboothco.com/tradeshow",
          breadcrumb: "https://thesocialboothco.com",
        },
      ],
      "socialboothlv.com",
    );

    expect(result).toEqual({ position: null, url: null });
  });

  it("keeps a plain domain match unchanged", async () => {
    // 360 photo booth rental las vegas: socialboothlv.com is #4.
    const result = await checkRank(
      [
        gotoItem(1, "https://joysquad.com"),
        gotoItem(3, "https://m.yelp.com"),
        {
          type: "organic",
          rank_group: 4,
          domain: "socialboothlv.com",
          url: "https://socialboothlv.com/",
          breadcrumb: "https://socialboothlv.com",
        },
      ],
      "socialboothlv.com",
    );

    expect(result).toEqual({ position: 4, url: "https://socialboothlv.com/" });
  });

  it.each([
    [
      "https://socialboothlv.com › holiday-party-photo-booth",
      "https://socialboothlv.com/holiday-party-photo-booth",
    ],
    [
      "socialboothlv.com › blog › trade-show-booths",
      "https://socialboothlv.com/blog/trade-show-booths",
    ],
    // Prettified or truncated segments are ambiguous: fall back to the root.
    [
      "https://socialboothlv.com › Photo Booths › 360 Booth...",
      "https://socialboothlv.com/",
    ],
  ])("rebuilds the URL from breadcrumb %j", async (breadcrumb, url) => {
    const result = await checkRank(
      [gotoItem(7, breadcrumb)],
      "socialboothlv.com",
    );

    expect(result).toEqual({ position: 7, url });
  });

  it("resolves a null-domain result from its breadcrumb", async () => {
    const result = await checkRank(
      [
        {
          type: "organic",
          rank_group: 9,
          domain: null,
          url: null,
          breadcrumb: "socialboothlv.com",
        },
      ],
      "socialboothlv.com",
    );

    expect(result).toEqual({ position: 9, url: "https://socialboothlv.com/" });
  });

  it("still matches a subdomain through the breadcrumb", async () => {
    // trade show photo booth las vegas: blog.studiozphotobooths.com is #10.
    const result = await checkRank(
      [
        gotoItem(9, "https://parlorphotobooths.com"),
        gotoItem(10, "https://blog.studiozphotobooths.com"),
      ],
      "studiozphotobooths.com",
    );

    expect(result).toEqual({
      position: 10,
      url: "https://blog.studiozphotobooths.com/",
    });
  });
});
