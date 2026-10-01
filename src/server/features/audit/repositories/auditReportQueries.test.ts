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
import type * as AuditReportQueriesModule from "./auditReportQueries";

// Real in-memory SQLite: audits.started_at is SQLite text while the as-of
// cutoff is ISO; only real SQL evaluation proves the comparison.
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let queries: typeof AuditReportQueriesModule;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  await client.executeMultiple(`
    CREATE TABLE audits (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      pages_crawled INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE TABLE audit_pages (
      id TEXT PRIMARY KEY,
      audit_id TEXT NOT NULL,
      url TEXT NOT NULL,
      crawl_depth INTEGER
    );
    CREATE TABLE audit_lighthouse_results (
      id TEXT PRIMARY KEY,
      audit_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      strategy TEXT NOT NULL,
      performance_score INTEGER,
      accessibility_score INTEGER,
      best_practices_score INTEGER,
      seo_score INTEGER,
      lcp_ms REAL,
      cls REAL,
      inp_ms REAL,
      ttfb_ms REAL,
      error_message TEXT,
      r2_key TEXT
    );
  `);
  // Imported after doMock: the module binds `db` at import time.
  queries = await import("./auditReportQueries");
});

afterAll(() => {
  client.close();
});

async function seedAudit(
  id: string,
  projectId: string,
  status: string,
  startedAt: string,
) {
  await client.execute({
    sql: "INSERT INTO audits (id, project_id, status, pages_crawled, started_at) VALUES (?, ?, ?, 10, ?)",
    args: [id, projectId, status, startedAt],
  });
}

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM audits; DELETE FROM audit_pages; DELETE FROM audit_lighthouse_results;
  `);
  await seedAudit("a_0905", "proj_1", "completed", "2026-09-05 00:52:13");
  await seedAudit("a_0930", "proj_1", "completed", "2026-09-30 22:50:11");
  await seedAudit("a_0930_running", "proj_1", "running", "2026-09-30 23:09:06");
  await seedAudit("a_1001", "proj_1", "completed", "2026-10-01 00:10:00");
  await seedAudit("a_other", "proj_2", "completed", "2026-09-30 23:30:00");
  await seedAudit("a_failed", "proj_3", "failed", "2026-09-20 10:00:00");
});

describe("getLatestAuditAtOrBefore", () => {
  const cutoff = "2026-09-30T23:59:59.999Z";

  it("prefers the latest completed audit started by the end of the as-of day", async () => {
    await expect(
      queries.getLatestAuditAtOrBefore("proj_1", cutoff),
    ).resolves.toMatchObject({
      id: "a_0930",
      status: "completed",
      startedAt: "2026-09-30 22:50:11",
      pagesCrawled: 10,
    });
  });

  it("falls back to the latest audit of any status, and null when none", async () => {
    await expect(
      queries.getLatestAuditAtOrBefore("proj_3", cutoff),
    ).resolves.toMatchObject({
      id: "a_failed",
      status: "failed",
    });
    await expect(
      queries.getLatestAuditAtOrBefore("proj_1", "2026-09-04T23:59:59.999Z"),
    ).resolves.toBeNull();
  });
});

describe("getMobileLighthouseForAudit", () => {
  it("returns successful mobile results with their page URL and depth", async () => {
    await client.executeMultiple(`
      INSERT INTO audit_pages VALUES ('p_home', 'a_0930', 'https://x.com/', 0), ('p_about', 'a_0930', 'https://x.com/about', 1);
      INSERT INTO audit_lighthouse_results (id, audit_id, page_id, strategy, performance_score, error_message, r2_key) VALUES
        ('l1', 'a_0930', 'p_home', 'mobile', 78, NULL, 'lighthouse/a_0930/l1.json'),
        ('l2', 'a_0930', 'p_home', 'desktop', 95, NULL, NULL),
        ('l3', 'a_0930', 'p_about', 'mobile', 70, NULL, NULL),
        ('l4', 'a_0930', 'p_about', 'mobile', NULL, 'timeout', NULL);
    `);
    const rows = await queries.getMobileLighthouseForAudit("a_0930");
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://x.com/",
          crawlDepth: 0,
          performanceScore: 78,
          r2Key: "lighthouse/a_0930/l1.json",
        }),
        expect.objectContaining({
          url: "https://x.com/about",
          crawlDepth: 1,
          performanceScore: 70,
          r2Key: null,
        }),
      ]),
    );
  });
});
