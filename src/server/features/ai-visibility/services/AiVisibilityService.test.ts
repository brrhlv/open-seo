import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as ServiceModule from "./AiVisibilityService";

// Real service + repository + Brand Lookup over in-memory SQLite (built from
// the shipped migration) and an in-memory R2 cache. Only DataForSEO is mocked,
// so the month idempotency and the 24 h cache reuse are exercised end to end.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: (promise: Promise<unknown>) => void promise.catch(() => {}),
}));

const mocks = vi.hoisted(() => {
  const cache = new Map<string, unknown>();
  return {
    cache,
    onCost: { current: undefined as ((usd: number) => void) | undefined },
    aiSearch: {
      aggregatedMetrics: vi.fn(),
      topPages: vi.fn(),
      mentionsSearch: vi.fn(),
      crossAggregatedMetrics: vi.fn(),
    },
  };
});

vi.mock("@/server/lib/dataforseo", () => ({
  CHATGPT_LANGUAGE_CODE: "en",
  CHATGPT_LOCATION_CODE: 2840,
  buildLlmTarget: ({ value }: { value: string }) => ({ domain: value }),
  createDataforseoClient: (
    _customer: unknown,
    options: { onCost?: (usd: number) => void } = {},
  ) => {
    mocks.onCost.current = options.onCost;
    return { aiSearch: mocks.aiSearch };
  },
}));

vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: async (prefix: string, params: unknown) =>
    `${prefix}:${JSON.stringify(params)}`,
  getCached: async (key: string) => mocks.cache.get(key) ?? null,
  setCached: async (key: string, value: unknown) => {
    mocks.cache.set(key, value);
  },
}));

const PROJECT = "proj-1";
const billingCustomer = {
  organizationId: "org-1",
  userId: "system",
  userEmail: "system@openseo.so",
};
const SEPT = new Date("2026-09-01T06:00:00Z");

let client: Client;
let Service: typeof ServiceModule;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  const migration = readFileSync("drizzle/0045_ai_visibility.sql", "utf8");
  await client.executeMultiple(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
      domain TEXT, archived_at TEXT
    );
    CREATE TABLE project_competitors (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, domain TEXT NOT NULL,
      name TEXT, notes TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT NOT NULL
    );
    ${migration.replaceAll("--> statement-breakpoint", "")}
  `);
  // Dynamic import after doMock so the repository binds to the test DB.
  Service = await import("./AiVisibilityService");

  // The service import graph is large; allow for a cold transform cache.
}, 30_000);

afterAll(() => client.close());

// Each DataForSEO call reports $0.10 through the client's onCost hook.
function charged<T>(value: T) {
  return async () => {
    mocks.onCost.current?.(0.1);
    return value;
  };
}

beforeEach(async () => {
  mocks.cache.clear();
  await client.executeMultiple(`
    DELETE FROM ai_visibility_snapshots;
    DELETE FROM ai_visibility_configs;
    DELETE FROM project_competitors;
    DELETE FROM projects;
    INSERT INTO projects (id, organization_id, name, domain)
      VALUES ('${PROJECT}', 'org-1', 'SBLV', 'socialboothlv.com');
    INSERT INTO project_competitors (id, project_id, domain, updated_by)
      VALUES ('c1', '${PROJECT}', 'rival.com', 'mcp');
  `);
  mocks.aiSearch.aggregatedMetrics.mockImplementation(
    async (input: { platform: "chat_gpt" | "google" }) => {
      mocks.onCost.current?.(0.1);
      return {
        platform: [
          {
            key: input.platform,
            mentions: input.platform === "google" ? 12 : 3,
            ai_search_volume: 100,
          },
        ],
      };
    },
  );
  mocks.aiSearch.topPages.mockImplementation(
    async (input: { platform: "chat_gpt" | "google" }) => {
      mocks.onCost.current?.(0.1);
      return [
        {
          key: "https://socialboothlv.com/pricing",
          platform: [{ key: input.platform, mentions: 4 }],
        },
        {
          key: "https://www.yelp.com/biz/x",
          platform: [{ key: input.platform, mentions: 9 }],
        },
      ];
    },
  );
  mocks.aiSearch.mentionsSearch.mockImplementation(
    charged([{ question: "best photo booth las vegas", ai_search_volume: 50 }]),
  );
  mocks.aiSearch.crossAggregatedMetrics.mockImplementation(
    charged([
      { key: "socialboothlv.com", platform: [{ mentions: 3 }] },
      { key: "rival.com", platform: [{ mentions: 1 }] },
    ]),
  );
});

// Rejects every ChatGPT call; Google calls resolve with `fallback`.
function failForChatGpt(fallback: () => Promise<unknown>) {
  return async (input: { platform: string }) =>
    input.platform === "chat_gpt"
      ? Promise.reject(new Error("upstream"))
      : fallback();
}

async function snapshotRows() {
  const result = await client.execute(
    "SELECT platform, period, mentions, cited_pages, json_extract(share_of_voice_json, '$.targetPct') AS sov_pct, billing_cost_usd FROM ai_visibility_snapshots ORDER BY platform",
  );
  return result.rows;
}

describe("AiVisibilityService.runCheck", () => {
  it("stores one row per platform with own cited pages, per-platform share of voice and the run's cost", async () => {
    await Service.AiVisibilityService.createTracker({
      projectId: PROJECT,
      projectDomain: "socialboothlv.com",
      now: SEPT,
    });

    const result = await Service.AiVisibilityService.runCheck({
      projectId: PROJECT,
      billingCustomer,
      now: SEPT,
    });

    // 3 calls per platform + 1 cross_aggregated per platform, $0.10 each.
    expect(result).toMatchObject({ status: "checked", period: "2026-09" });
    expect(result.costUsd).toBeCloseTo(0.8);
    expect(mocks.aiSearch.crossAggregatedMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        groups: [
          expect.objectContaining({ key: "socialboothlv.com" }),
          expect.objectContaining({ key: "rival.com" }),
        ],
      }),
    );
    const rows = await snapshotRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      platform: "google",
      period: "2026-09",
      mentions: 12,
      // yelp.com is a cited source, not one of the target's pages.
      cited_pages: 1,
    });
    expect(Number(rows[1]?.billing_cost_usd)).toBeCloseTo(0.4);
    expect(rows[1]?.sov_pct).toBe(75);
  });

  it("skips DataForSEO when the month is already captured", async () => {
    await Service.AiVisibilityService.createTracker({
      projectId: PROJECT,
      projectDomain: "socialboothlv.com",
    });
    await Service.AiVisibilityService.runCheck({
      projectId: PROJECT,
      billingCustomer,
      now: SEPT,
    });
    vi.clearAllMocks();

    const again = await Service.AiVisibilityService.runCheck({
      projectId: PROJECT,
      billingCustomer,
      now: new Date("2026-09-20T00:00:00Z"),
    });

    expect(again).toMatchObject({ status: "already_captured", costUsd: 0 });
    expect(mocks.aiSearch.mentionsSearch).not.toHaveBeenCalled();
  });

  it("reuses the 24 h lookup cache on a forced re-run, adding no cost", async () => {
    await Service.AiVisibilityService.createTracker({
      projectId: PROJECT,
      projectDomain: "socialboothlv.com",
    });
    await Service.AiVisibilityService.runCheck({
      projectId: PROJECT,
      billingCustomer,
      now: SEPT,
    });
    vi.clearAllMocks();

    const forced = await Service.AiVisibilityService.runCheck({
      projectId: PROJECT,
      billingCustomer,
      force: true,
      now: SEPT,
    });

    expect(forced).toMatchObject({ status: "checked", costUsd: 0 });
    expect(mocks.aiSearch.aggregatedMetrics).not.toHaveBeenCalled();
    const rows = await snapshotRows();
    expect(rows).toHaveLength(2);
    expect(Number(rows[0]?.billing_cost_usd)).toBeCloseTo(0.4);
  });

  it("writes no row for a platform whose calls all failed, so the month retries", async () => {
    await Service.AiVisibilityService.createTracker({
      projectId: PROJECT,
      projectDomain: "socialboothlv.com",
      includeCompetitors: false,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.aiSearch.aggregatedMetrics.mockImplementation(
      failForChatGpt(async () => ({
        platform: [{ key: "google", mentions: 5 }],
      })),
    );
    mocks.aiSearch.topPages.mockImplementation(failForChatGpt(async () => []));
    mocks.aiSearch.mentionsSearch.mockImplementation(
      failForChatGpt(async () => []),
    );

    const result = await Service.AiVisibilityService.runCheck({
      projectId: PROJECT,
      billingCustomer,
      now: SEPT,
    });

    expect(result.platforms).toEqual(["google"]);
    expect(mocks.aiSearch.crossAggregatedMetrics).not.toHaveBeenCalled();
    expect(await snapshotRows()).toHaveLength(1);
  });
});

describe("AiVisibilityService.createTracker", () => {
  it("defaults to monthly on the 1st with competitors on, except placeholder brands", async () => {
    const tracker = await Service.AiVisibilityService.createTracker({
      projectId: PROJECT,
      projectDomain: "socialboothlv.com",
      now: new Date("2026-10-09T12:00:00Z"),
    });
    expect(tracker).toMatchObject({
      target: "socialboothlv.com",
      scheduleInterval: "monthly",
      includeCompetitors: true,
      nextCheckAt: "2026-11-01T06:00:00.000Z",
    });

    for (const domain of [
      "flipwithaj.com",
      "ajgventuregroup.com",
      "desertmedicalconsulting.com",
    ]) {
      const placeholder = await Service.AiVisibilityService.createTracker({
        projectId: PROJECT,
        projectDomain: domain,
      });
      expect(placeholder.includeCompetitors).toBe(false);
    }
  });
});

describe("AiVisibilityService.getHistory", () => {
  it("returns month-over-month deltas per platform", async () => {
    await client.executeMultiple(`
      INSERT INTO ai_visibility_snapshots
        (project_id, domain, platform, period, mentions, cited_pages, share_of_voice_json, captured_at)
      VALUES
        ('${PROJECT}', 'socialboothlv.com', 'google', '2026-08', 10, 2, '{"targetPct":50,"entries":[]}', '2026-08-01T06:00:00.000Z'),
        ('${PROJECT}', 'socialboothlv.com', 'google', '2026-09', 15, 1, '{"targetPct":60,"entries":[]}', '2026-09-01T06:00:00.000Z'),
        ('${PROJECT}', 'socialboothlv.com', 'chat_gpt', '2026-09', 3, 0, NULL, '2026-09-01T06:00:00.000Z');
    `);

    const history = await Service.AiVisibilityService.getHistory(PROJECT);

    expect(history.latest.map((row) => [row.platform, row.delta])).toEqual([
      ["chat_gpt", null],
      ["google", { mentions: 5, citedPages: -1, shareOfVoicePct: 10 }],
    ]);
    expect(history.history.map((p) => p.period)).toEqual([
      "2026-08",
      "2026-09",
      "2026-09",
    ]);
  });
});
