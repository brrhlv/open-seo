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
import type * as LocalGridServiceModule from "./LocalGridService";
import type * as SchedulerModule from "./scheduledLocalGridChecks";

// Real due query + compare-and-set over in-memory SQLite; only the paid run
// itself (runCheck) is mocked.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  runCheck:
    vi.fn<(input: { projectId: string; limit?: number }) => Promise<unknown>>(),
}));

vi.mock(
  "@/server/features/local-grid/services/LocalGridService",
  async (importOriginal) => {
    const actual = await importOriginal<typeof LocalGridServiceModule>();
    return {
      ...actual,
      LocalGridService: {
        ...actual.LocalGridService,
        runCheck: mocks.runCheck,
      },
    };
  },
);

const NOW = new Date("2026-12-02T07:02:00Z");

let client: Client;
let Scheduler: typeof SchedulerModule;

beforeAll(async () => {
  const testDb = await createLocalGridTestDb();
  client = testDb.client;
  vi.doMock("@/db", () => ({ db: testDb.db }));
  // Dynamic import after doMock so the repository binds to the test DB.
  Scheduler = await import("./scheduledLocalGridChecks");
}, 60_000);

afterAll(() => client.close());

function tracker(id: string, nextCheckAt: string, schedule = "monthly") {
  return `
    INSERT INTO projects (id, organization_id, name) VALUES ('p-${id}', 'org-1', '${id}');
    INSERT INTO local_grid_configs (id, project_id, target_place_id, center_latitude, center_longitude, schedule_interval, next_check_at)
      VALUES ('${id}', 'p-${id}', 'place', 36.2, -115.2, '${schedule}', '${nextCheckAt}');
  `;
}

async function config(id: string) {
  const result = await client.execute({
    sql: "SELECT next_check_at, last_error FROM local_grid_configs WHERE id = ?",
    args: [id],
  });
  return result.rows[0];
}

const ran = (remaining: string[]) => ({
  period: "2026-12",
  checked: [{ keyword: "a" }],
  alreadyCaptured: [],
  remaining,
  costUsd: 0.018,
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.runCheck.mockResolvedValue(ran([]));
  await client.executeMultiple(`
    DELETE FROM local_grid_configs;
    DELETE FROM projects;
  `);
});

describe("runScheduledLocalGridChecks", () => {
  it("grids one keyword of the oldest due monthly tracker per tick", async () => {
    await client.executeMultiple(
      tracker("older", "2026-12-02T07:00:00.000Z") +
        tracker("newer", "2026-12-02T07:01:00.000Z") +
        tracker("future", "2027-01-02T07:00:00.000Z") +
        tracker("manual", "2026-12-01T00:00:00.000Z", "manual"),
    );
    await Scheduler.runScheduledLocalGridChecks(NOW);

    expect(mocks.runCheck).toHaveBeenCalledTimes(1);
    expect(mocks.runCheck).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-older", limit: 1 }),
    );
    expect((await config("older"))?.next_check_at).toBe(
      "2027-01-02T07:00:00.000Z",
    );
  });

  it("keeps a tracker due while keywords remain this month", async () => {
    await client.executeMultiple(tracker("t", "2026-12-02T07:00:00.000Z"));
    mocks.runCheck.mockResolvedValue(ran(["b", "c"]));
    await Scheduler.runScheduledLocalGridChecks(NOW);
    expect((await config("t"))?.next_check_at).toBe(NOW.toISOString());
  });

  it("records a failure and retries in six hours", async () => {
    await client.executeMultiple(tracker("t", "2026-12-02T07:00:00.000Z"));
    mocks.runCheck.mockRejectedValue(new Error("DataForSEO down"));
    await Scheduler.runScheduledLocalGridChecks(NOW);
    expect(await config("t")).toMatchObject({
      next_check_at: "2026-12-02T13:02:00.000Z",
      last_error: "DataForSEO down",
    });
  });
});
