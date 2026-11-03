import { readdirSync, readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as RepositoryModule from "./GbpWatchRepository";

// The repository's SQL against the shipped D1 migration in in-memory SQLite.
// The migration is found by name so a renumbered regeneration still loads.

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let Repo: typeof RepositoryModule.GbpWatchRepository;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  const file = readdirSync("drizzle").find((name) =>
    name.endsWith("_gbp_watch.sql"),
  );
  if (!file) throw new Error("gbp_watch migration not found");
  const migration = readFileSync(`drizzle/${file}`, "utf8");
  await client.executeMultiple(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
      domain TEXT, location_code INTEGER NOT NULL DEFAULT 2840,
      language_code TEXT NOT NULL DEFAULT 'en', archived_at TEXT
    );
    INSERT INTO projects (id, organization_id, name) VALUES ('p1', 'o1', 'SBLV'), ('p2', 'o1', 'Other');
    ${migration.replaceAll("--> statement-breakpoint", "")}
  `);
  // Dynamic import after doMock so the repository binds to the test DB.
  Repo = (await import("./GbpWatchRepository")).GbpWatchRepository;
});

afterAll(() => client.close());

const watch = {
  placeId: null,
  cid: "5590594803775798319",
  listingId: null,
  expectedJson: "{}",
  scheduleInterval: "weekly" as const,
  isActive: true,
};

describe("GbpWatchRepository", () => {
  it("keeps one watch per project and finds and claims the due ones once", async () => {
    await Repo.upsertConfig({
      ...watch,
      projectId: "p1",
      nextCheckAt: "2026-11-09T14:00:00.000Z",
    });
    const updated = await Repo.upsertConfig({
      ...watch,
      projectId: "p1",
      listingId: "14154039352732233380",
      nextCheckAt: "2026-11-09T14:00:00.000Z",
    });
    await Repo.upsertConfig({
      ...watch,
      projectId: "p2",
      scheduleInterval: "manual",
      nextCheckAt: null,
    });
    expect(updated.listingId).toBe("14154039352732233380");

    const due = await Repo.getDueConfigs("2026-11-09T14:05:00.000Z", 5);
    expect(due).toEqual([
      expect.objectContaining({
        projectId: "p1",
        organizationId: "o1",
        locationCode: 2840,
        languageCode: "en",
      }),
    ]);

    const claim = {
      configId: updated.id,
      observedNextCheckAt: "2026-11-09T14:00:00.000Z",
      nextCheckAt: "2026-11-16T14:00:00.000Z",
    };
    expect(await Repo.claimDueConfig(claim)).toBe(true);
    expect(await Repo.claimDueConfig(claim)).toBe(false);
  });

  it("lists snapshots newest first", async () => {
    for (const capturedAt of [
      "2026-11-02T14:00:00.000Z",
      "2026-11-16T14:00:00.000Z",
      "2026-11-09T14:00:00.000Z",
    ]) {
      await Repo.insertSnapshot({
        projectId: "p1",
        capturedAt,
        reviewsJson: null,
      });
    }
    const rows = await Repo.listRecentSnapshots("p1", 2);
    expect(rows.map((row) => row.capturedAt)).toEqual([
      "2026-11-16T14:00:00.000Z",
      "2026-11-09T14:00:00.000Z",
    ]);
    expect(rows[0]).toMatchObject({
      additionalCategoriesJson: "[]",
      changesJson: "[]",
      reviewsJson: null,
    });
  });
});
