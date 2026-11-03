import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalGridTestDb } from "../local-grid-test-support";
import type * as ServiceModule from "./LocalGridService";
import type * as SummaryModule from "./localGridSummary";

// The public `localGrid` contract end to end: real service, repository and
// shaping over in-memory SQLite; only DataForSEO is mocked.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ local: vi.fn() }));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({ serp: { local: mocks.local } }),
}));

const PROJECT = "proj-1";
const BILLING = { userId: "u", userEmail: "u@x.com", organizationId: "org" };

let client: Client;
let Service: typeof ServiceModule;
let Summary: typeof SummaryModule;

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
  Summary = await import("./localGridSummary");
  await client.execute(
    `INSERT INTO projects (id, organization_id, name) VALUES ('${PROJECT}', 'org', 'SBLV')`,
  );
}, 60_000);

afterAll(() => client.close());

describe("getLocalGridSummary", () => {
  it("is untracked with no keywords before a tracker exists", async () => {
    expect(await Summary.getLocalGridSummary(PROJECT)).toMatchObject({
      tracked: false,
      target: null,
      keywords: [],
    });
  });

  it("returns the latest grid per keyword with the previous month and the change", async () => {
    await Service.LocalGridService.createTracker({
      projectId: PROJECT,
      keywords: ["brand activation photo booth las vegas"],
      target: { placeId: "ChIJuy0J", cid: "559", name: "Social Booth LV" },
      center: { latitude: 36.2108236, longitude: -115.2695665 },
      now: new Date("2026-10-01T00:00:00Z"),
    });
    const run = (iso: string) =>
      Service.LocalGridService.runCheck({
        projectId: PROJECT,
        billingCustomer: BILLING,
        now: new Date(iso),
      });
    // October: rank 4 everywhere. November: rank 1 except one point not found.
    mocks.local.mockResolvedValue([
      { rank_absolute: 1, title: "BoothNV", cid: "447" },
      { rank_absolute: 4, cid: "559" },
    ]);
    await run("2026-10-02T07:00:00Z");
    let call = 0;
    mocks.local.mockImplementation(async () =>
      ++call === 3
        ? [{ rank_absolute: 1, title: "KL360", cid: "115" }]
        : [{ rank_absolute: 1, cid: "559" }],
    );
    await run("2026-11-02T07:00:00Z");

    const summary = await Summary.getLocalGridSummary(PROJECT);
    expect(summary).toMatchObject({
      tracked: true,
      paused: false,
      target: { name: "Social Booth LV", placeId: "ChIJuy0J", cid: "559" },
      center: { latitude: 36.2108236, longitude: -115.2695665 },
      gridSize: 3,
      spacingKm: 2,
      scheduleInterval: "monthly",
      lastCheckedAt: "2026-11-02T07:00:00.000Z",
    });
    const [kw] = summary.keywords;
    expect(kw).toMatchObject({
      keyword: "brand activation photo booth las vegas",
      period: "2026-11",
      zoom: 13,
      pointsSearched: 9,
      pointsFailed: 0,
      pointsFound: 8,
      solvPct: 88.89,
      arp: 1,
      atrp: 3.22,
      previous: { period: "2026-10", arp: 4, solvPct: 0, pointsFound: 9 },
      delta: { solvPct: 88.89, arp: -3, atrp: -0.78, pointsFound: -1 },
    });
    expect(kw?.cells[2]).toMatchObject({
      row: 0,
      col: 2,
      rank: null,
      resultsCount: 1,
      topCompetitor: { title: "KL360", cid: "115", rank: 1 },
      error: false,
    });
    expect(kw?.previous?.cells[0]).toEqual({ row: 0, col: 0, rank: 4 });
  });

  it("a paused tracker keeps its stored grids", async () => {
    await client.execute("UPDATE local_grid_configs SET is_active = 0");
    const summary = await Summary.getLocalGridSummary(PROJECT);
    expect(summary).toMatchObject({ tracked: true, paused: true });
    expect(summary.keywords).toHaveLength(1);
  });
});
