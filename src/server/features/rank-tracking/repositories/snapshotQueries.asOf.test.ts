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
import type * as SnapshotQueriesModule from "./snapshotQueries";

// Real in-memory SQLite: the as-of cutoff is a text comparison across ISO and
// SQLite timestamp formats, which only real SQL evaluation proves.
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let getLatestCompletedFullRunAtOrBefore: typeof SnapshotQueriesModule.getLatestCompletedFullRunAtOrBefore;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  await client.executeMultiple(`
    CREATE TABLE rank_check_runs (
      id TEXT PRIMARY KEY,
      config_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      keywords_total INTEGER NOT NULL DEFAULT 0,
      keywords_checked INTEGER NOT NULL DEFAULT 0,
      is_subset_run INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
  `);
  // Imported after doMock: the module binds `db` at import time.
  ({ getLatestCompletedFullRunAtOrBefore } = await import("./snapshotQueries"));
});

afterAll(() => {
  client.close();
});

async function seedRun(
  id: string,
  completedAt: string | null,
  opts: { configId?: string; status?: string; subset?: number } = {},
) {
  await client.execute({
    sql: "INSERT INTO rank_check_runs (id, config_id, project_id, status, is_subset_run, completed_at) VALUES (?, ?, 'proj_1', ?, ?, ?)",
    args: [
      id,
      opts.configId ?? "cfg_1",
      opts.status ?? "completed",
      opts.subset ?? 0,
      completedAt,
    ],
  });
}

describe("getLatestCompletedFullRunAtOrBefore", () => {
  beforeEach(async () => {
    await client.execute("DELETE FROM rank_check_runs");
    await seedRun("run_0829", "2026-08-29T03:17:00.000Z");
    await seedRun("run_0929", "2026-09-29T03:17:00.000Z");
    await seedRun("run_0930_sqlite", "2026-09-30 22:44:15");
    await seedRun("run_1001", "2026-10-01T00:00:01.000Z");
    await seedRun("run_subset", "2026-09-30T23:00:00.000Z", { subset: 1 });
    await seedRun("run_failed", null, { status: "failed" });
    await seedRun("run_other_cfg", "2026-09-30T23:30:00.000Z", {
      configId: "cfg_2",
    });
  });

  it("returns the latest completed full run up to the end of the as-of day, across timestamp formats", async () => {
    await expect(
      getLatestCompletedFullRunAtOrBefore("cfg_1", "2026-09-30T23:59:59.999Z"),
    ).resolves.toEqual({
      id: "run_0930_sqlite",
      completedAt: "2026-09-30 22:44:15",
    });
    await expect(
      getLatestCompletedFullRunAtOrBefore("cfg_1", "2026-09-29T23:59:59.999Z"),
    ).resolves.toMatchObject({ id: "run_0929" });
  });

  it("returns null when no completed full run precedes the cutoff", async () => {
    await expect(
      getLatestCompletedFullRunAtOrBefore("cfg_1", "2026-08-01T23:59:59.999Z"),
    ).resolves.toBeNull();
  });
});
