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
import { AppError } from "@/server/lib/errors";
import { createLocalGridTestDb } from "../local-grid-test-support";
import type * as SchedulerModule from "./scheduledLocalGridChecks";

// Real scheduler, service and repository over in-memory SQLite, tick by tick;
// only DataForSEO is mocked, per keyword.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: vi.fn(),
}));

type Behaviour = "ok" | "throw" | "degraded" | "no-credits";
const mocks = vi.hoisted(() => ({
  behaviour: new Map<string, Behaviour>(),
  calls: [] as string[],
  points: new Map<string, number>(),
}));

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({
    serp: {
      local: async ({ keyword }: { keyword: string }) => {
        mocks.calls.push(keyword);
        const n = (mocks.points.get(keyword) ?? 0) + 1;
        mocks.points.set(keyword, n);
        const behaviour = mocks.behaviour.get(keyword) ?? "ok";
        if (behaviour === "no-credits")
          throw new AppError("INSUFFICIENT_CREDITS", "No credits");
        if (behaviour === "throw") throw new Error(`${keyword} upstream down`);
        // Degraded: points 1-3 and 9 of each grid fail (4 of 9, over a third).
        if (behaviour === "degraded" && n % 9 < 4) {
          throw new Error("point failed");
        }
        return [{ rank_absolute: 1, cid: "559" }];
      },
    },
  }),
}));

let client: Client;
let Scheduler: typeof SchedulerModule;

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
  Scheduler = await import("./scheduledLocalGridChecks");
}, 60_000);

afterAll(() => client.close());

const START = "2026-12-02T07:00:00.000Z";

function tracker(
  id: string,
  keywords: string[],
  options: {
    next?: string;
    schedule?: string;
    leaseUntil?: string;
    gridSize?: number;
  } = {},
) {
  const lease = options.leaseUntil ? `'${options.leaseUntil}'` : "NULL";
  const rows = keywords.map(
    (k, i) =>
      `INSERT INTO local_grid_keywords (id, config_id, keyword, created_at) VALUES ('${id}-${k}', '${id}', '${k}', '2026-11-01T00:00:0${i}Z');`,
  );
  return `
    INSERT INTO projects (id, organization_id, name) VALUES ('p-${id}', 'org-1', '${id}');
    INSERT INTO local_grid_configs (id, project_id, target_cid, center_latitude, center_longitude, grid_size, schedule_interval, next_check_at, lease_until)
      VALUES ('${id}', 'p-${id}', '559', 36.2, -115.2, ${options.gridSize ?? 3}, '${options.schedule ?? "monthly"}', '${options.next ?? START}', ${lease});
    ${rows.join("\n")}
  `;
}

async function config(id: string) {
  const result = await client.execute({
    sql: "SELECT next_check_at, last_error, lease_until FROM local_grid_configs WHERE id = ?",
    args: [id],
  });
  return result.rows[0];
}

/** Run a tick at `iso` and return the keywords it gridded. */
async function tick(iso: string) {
  const before = mocks.calls.length;
  await Scheduler.runScheduledLocalGridChecks(new Date(iso));
  return [...new Set(mocks.calls.slice(before))];
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.behaviour.clear();
  mocks.points.clear();
  mocks.calls.length = 0;
  await client.executeMultiple(`
    DELETE FROM local_grid_cells; DELETE FROM local_grid_snapshots;
    DELETE FROM local_grid_keywords; DELETE FROM local_grid_configs;
    DELETE FROM projects;
  `);
});

describe("runScheduledLocalGridChecks", () => {
  it("grids up to 75 calls of the oldest due tracker per tick, then waits for the next 2nd", async () => {
    // 5x5: 25 calls a keyword, so three keywords a tick.
    await client.executeMultiple(
      tracker("older", ["a", "b", "c", "d"], { gridSize: 5 }) +
        tracker("newer", ["x"], { next: "2026-12-02T07:06:00.000Z" }) +
        tracker("future", ["y"], { next: "2027-01-02T07:00:00.000Z" }) +
        tracker("manual", ["z"], { schedule: "manual" }) +
        tracker("leased", ["w"], {
          next: "2026-12-01T00:00:00.000Z",
          leaseUntil: "2026-12-02T07:12:00.000Z",
        }),
    );
    expect(await tick("2026-12-02T07:05:00.000Z")).toEqual(["a", "b", "c"]);
    expect(mocks.calls).toHaveLength(75);
    expect(await config("older")).toMatchObject({
      next_check_at: "2026-12-02T07:05:00.000Z",
      lease_until: null,
    });
    expect(await tick("2026-12-02T07:10:00.000Z")).toEqual(["d"]);
    expect((await config("older"))?.next_check_at).toBe(
      "2027-01-02T07:00:00.000Z",
    );
    // Once its lease expires the leased tracker (due earliest) runs first.
    expect(await tick("2026-12-02T07:15:00.000Z")).toEqual(["w"]);
    expect(await tick("2026-12-02T07:20:00.000Z")).toEqual(["x"]);
  });

  it("a grid with over a third of its points failed is stored but retried", async () => {
    await client.executeMultiple(tracker("t", ["a"]));
    mocks.behaviour.set("a", "degraded");
    expect(await tick("2026-12-02T07:05:00.000Z")).toEqual(["a"]);
    const stored = await client.execute(
      "SELECT points_failed FROM local_grid_snapshots",
    );
    expect(stored.rows[0]?.points_failed).toBe(4);
    expect((await config("t"))?.next_check_at).toBe("2026-12-02T13:05:00.000Z");

    mocks.behaviour.set("a", "ok");
    expect(await tick("2026-12-02T13:05:00.000Z")).toEqual(["a"]);
    expect((await config("t"))?.next_check_at).toBe("2027-01-02T07:00:00.000Z");
  });

  it("a keyword that keeps failing goes behind the others and stops after three tries", async () => {
    await client.executeMultiple(
      tracker("t", ["a", "b", "c", "d", "e"], { gridSize: 5 }),
    );
    mocks.behaviour.set("a", "throw");

    expect(await tick("2026-12-02T07:05:00.000Z")).toEqual(["a", "b", "c"]); // a (1)
    // Untried d and e go before a's retry.
    expect(await tick("2026-12-02T07:10:00.000Z")).toEqual(["d", "e", "a"]); // a (2)
    // Only a's retry is left: after the delay, not on the next tick.
    expect((await config("t"))?.next_check_at).toBe("2026-12-02T13:10:00.000Z");

    expect(await tick("2026-12-02T13:10:00.000Z")).toEqual(["a"]); // a (3)
    expect(await config("t")).toMatchObject({
      next_check_at: "2027-01-02T07:00:00.000Z",
      last_error: "a: a upstream down",
    });
  });

  it("an account-wide failure stops the run, releases the lease and retries in six hours", async () => {
    await client.executeMultiple(tracker("t", ["a"]));
    mocks.behaviour.set("a", "no-credits");
    await tick("2026-12-02T07:05:00.000Z");
    expect(await config("t")).toMatchObject({
      next_check_at: "2026-12-02T13:05:00.000Z",
      last_error: "No credits",
      lease_until: null,
    });
  });
});
