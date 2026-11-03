import type { Client } from "@libsql/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createLocalGridTestDb } from "../local-grid-test-support";
import type * as ServiceModule from "./LocalGridService";

// Real service + repository over in-memory SQLite; only DataForSEO is mocked.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  local: vi.fn<(input: { keyword: string }) => Promise<unknown[]>>(),
}));

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: (
    _customer: unknown,
    options: { onCost?: (usd: number) => void } = {},
  ) => ({
    serp: {
      local: async (input: { keyword: string }) => {
        options.onCost?.(0.002);
        return mocks.local(input);
      },
    },
  }),
}));

const PROJECT = "proj-1";
const BILLING = {
  userId: "u",
  userEmail: "u@example.com",
  organizationId: "org-1",
};
const TARGET = { placeId: "ChIJuy0J", cid: "559", name: "Social Booth LV" };
const CENTER = { latitude: 36.2108236, longitude: -115.2695665 };

let client: Client;
let Service: typeof ServiceModule;

beforeAll(async () => {
  const testDb = await createLocalGridTestDb();
  client = testDb.client;
  vi.doMock("@/db", () => ({ db: testDb.db }));
  vi.doMock("@/db/runBatch", () => ({
    runBatch: async (build: (tx: unknown) => Promise<unknown>[]) => {
      for (const statement of build(testDb.db)) await statement;
    },
  }));
  // Dynamic import after doMock so the repository binds to the test DB.
  Service = await import("./LocalGridService");
}, 60_000);

afterAll(() => client.close());

beforeEach(async () => {
  mocks.local.mockResolvedValue([
    { rank_absolute: 1, title: "BoothNV", cid: "447" },
    { rank_absolute: 2, title: "Social Booth LV", place_id: "ChIJuy0J" },
  ]);
  await client.executeMultiple(`
    DELETE FROM local_grid_cells; DELETE FROM local_grid_snapshots;
    DELETE FROM local_grid_keywords; DELETE FROM local_grid_configs;
    DELETE FROM projects;
    INSERT INTO projects (id, organization_id, name) VALUES ('${PROJECT}', 'org-1', 'SBLV');
  `);
});

async function track(
  keywords: string[],
  now = new Date("2026-11-01T12:00:00Z"),
) {
  return Service.LocalGridService.createTracker({
    projectId: PROJECT,
    keywords,
    target: TARGET,
    center: CENTER,
    now,
  });
}

async function count(table: string) {
  const result = await client.execute(`SELECT count(*) AS n FROM ${table}`);
  return Number(result.rows[0]?.n);
}

describe("createTracker", () => {
  it("needs a place_id or cid, dedupes keywords and schedules the 2nd", async () => {
    await expect(
      Service.LocalGridService.createTracker({
        projectId: PROJECT,
        keywords: ["a"],
        target: { name: "Social Booth LV" },
        center: CENTER,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const { config, keywords } = await track([
      "photo booth rental las vegas",
      " Photo booth rental  las vegas ",
      "brand activation photo booth las vegas",
    ]);
    expect(keywords).toEqual([
      "photo booth rental las vegas",
      "brand activation photo booth las vegas",
    ]);
    expect(config.nextCheckAt).toBe("2026-11-02T07:00:00.000Z");
  });

  it("lowercases keywords and accepts a 5x5 grid", async () => {
    const { keywords } = await track(["Photo Booth LAS VEGAS"]);
    expect(keywords).toEqual(["photo booth las vegas"]);
    const { config } = await Service.LocalGridService.createTracker({
      projectId: PROJECT,
      keywords: ["a"],
      target: TARGET,
      center: CENTER,
      gridSize: 5,
    });
    expect(config.gridSize).toBe(5);
  });
});

describe("runCheck", () => {
  it("stores one snapshot per keyword per month with its cells, and skips a captured month", async () => {
    await track(["brand activation photo booth las vegas"]);
    const now = new Date("2026-11-02T07:00:00Z");

    const first = await Service.LocalGridService.runCheck({
      projectId: PROJECT,
      billingCustomer: BILLING,
      now,
    });
    expect(first.checked).toEqual([
      expect.objectContaining({
        keyword: "brand activation photo booth las vegas",
        pointsFound: 9,
        solvPct: 100,
        arp: 2,
        atrp: 2,
      }),
    ]);
    expect(first.costUsd).toBeCloseTo(0.018);
    expect(await count("local_grid_cells")).toBe(9);

    const again = await Service.LocalGridService.runCheck({
      projectId: PROJECT,
      billingCustomer: BILLING,
      now,
    });
    expect(again).toMatchObject({
      checked: [],
      alreadyCaptured: ["brand activation photo booth las vegas"],
      costUsd: 0,
    });
    expect(mocks.local).toHaveBeenCalledTimes(9);
  });

  it("force replaces the month's cells and adds the cost", async () => {
    await track(["kw"]);
    const now = new Date("2026-11-02T07:00:00Z");
    const run = { projectId: PROJECT, billingCustomer: BILLING, now };
    await Service.LocalGridService.runCheck(run);
    mocks.local.mockResolvedValue([{ rank_absolute: 5, cid: "559" }]);
    await Service.LocalGridService.runCheck({ ...run, force: true });

    const rows = await client.execute(
      "SELECT arp, billing_cost_usd AS cost FROM local_grid_snapshots",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.arp).toBe(5);
    expect(Number(rows.rows[0]?.cost)).toBeCloseTo(0.036);
    expect(await count("local_grid_cells")).toBe(9);
  });

  it("runs at most `limit` keywords and hands back the rest", async () => {
    await track(["a", "b", "c"]);
    const result = await Service.LocalGridService.runCheck({
      projectId: PROJECT,
      billingCustomer: BILLING,
      limit: 1,
      now: new Date("2026-11-02T07:00:00Z"),
    });
    expect(result.checked.map((r) => r.keyword)).toEqual(["a"]);
    expect(result.remaining).toEqual(["b", "c"]);
  });
});

describe("runCheck limits", () => {
  const now = new Date("2026-11-02T07:00:00Z");
  const run = { projectId: PROJECT, billingCustomer: BILLING, now };

  it("caps a run at 75 Maps calls: eight 3x3 keywords, three 5x5 ones", async () => {
    const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    await track(nine);
    const three = await Service.LocalGridService.runCheck(run);
    expect(three.checked).toHaveLength(8);
    expect(three.remaining).toEqual(["i"]);
    expect(mocks.local).toHaveBeenCalledTimes(72);

    await client.execute("UPDATE local_grid_configs SET grid_size = 5");
    mocks.local.mockClear();
    const five = await Service.LocalGridService.runCheck({
      ...run,
      force: true,
    });
    expect(five.checked).toHaveLength(3);
    expect(mocks.local).toHaveBeenCalledTimes(75);
    expect([3, 5].map(Service.keywordsPerRun)).toEqual([8, 3]);
  });

  it("matches keywords whatever their case", async () => {
    await track(["Brand Activation"]);
    const result = await Service.LocalGridService.runCheck({
      ...run,
      keywords: ["BRAND activation"],
    });
    expect(result.checked.map((r) => r.keyword)).toEqual(["brand activation"]);
  });

  it("refuses to run while another run holds the tracker", async () => {
    await track(["a"]);
    await client.execute(
      "UPDATE local_grid_configs SET lease_until = '2026-11-02T07:05:00.000Z'",
    );
    await expect(Service.LocalGridService.runCheck(run)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(mocks.local).not.toHaveBeenCalled();
  });
});

describe("getLatest", () => {
  it("returns the latest and previous month per keyword, with cells, in tracker order", async () => {
    await track(["b", "a"]);
    const run = { projectId: PROJECT, billingCustomer: BILLING };
    await Service.LocalGridService.runCheck({
      ...run,
      now: new Date("2026-10-02T07:00:00Z"),
    });
    mocks.local.mockResolvedValue([{ rank_absolute: 1, cid: "559" }]);
    await Service.LocalGridService.runCheck({
      ...run,
      now: new Date("2026-11-02T07:00:00Z"),
    });

    const { keywords } = await Service.LocalGridService.getLatest(PROJECT);
    expect(keywords.map((k) => k.keyword)).toEqual(["b", "a"]);
    const [b] = keywords;
    expect(b?.latest).toMatchObject({ period: "2026-11", arp: 1 });
    expect(b?.previous).toMatchObject({ period: "2026-10", arp: 2 });
    expect(b?.latest.cells).toHaveLength(9);
    expect(b?.latest.cells[0]).toMatchObject({
      row: 0,
      col: 0,
      rank: 1,
      topCompetitor: null,
    });
    expect(b?.previous?.cells[0]?.topCompetitor).toEqual({
      title: "BoothNV",
      cid: "447",
      rank: 1,
    });
  });
});
