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
import type * as SchedulerModule from "./scheduledIndexInspections";

// Real due query + upsert over in-memory SQLite; only the Google call
// (GscService.inspectUrls) and the hosted-mode check are mocked.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: vi.fn(),
}));

type InspectInput = { projectId: string; urls: string[] };
const mocks = vi.hoisted(() => ({
  inspectUrls: vi.fn<(input: InspectInput) => Promise<unknown>>(),
  isHosted: vi.fn(() => Promise.resolve(false)),
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { inspectUrls: mocks.inspectUrls },
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: mocks.isHosted,
}));

const NOW = new Date("2026-11-02T10:00:00.000Z");

let client: Client;
let Scheduler: typeof SchedulerModule;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  vi.doMock("@/db", () => ({ db: drizzle(client) }));
  // Columns the queries touch; url_inspections matches the migration.
  await client.executeMultiple(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, archived_at TEXT);
    CREATE TABLE gsc_connections (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, site_url TEXT NOT NULL);
    CREATE TABLE project_key_pages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, url TEXT NOT NULL);
    CREATE TABLE url_inspections (
      id text PRIMARY KEY NOT NULL, project_id text NOT NULL, url text NOT NULL,
      inspected_url text NOT NULL, verdict text, coverage_state text, indexing_state text,
      robots_txt_state text, page_fetch_state text, google_canonical text, user_canonical text,
      last_crawl_time text, crawled_as text, error text, inspected_at text NOT NULL
    );
    CREATE UNIQUE INDEX url_inspections_project_url_idx ON url_inspections (project_id, url);
  `);
  // Dynamic import after doMock so the repository binds to the test DB.
  Scheduler = await import("./scheduledIndexInspections");
}, 30_000);

afterAll(() => client.close());

function project(
  id: string,
  siteUrl: string | null,
  pages: string[],
  archived = false,
) {
  return `
    INSERT INTO projects (id, archived_at) VALUES ('${id}', ${archived ? "'2026-10-01'" : "NULL"});
    ${siteUrl ? `INSERT INTO gsc_connections (id, project_id, site_url) VALUES ('g-${id}', '${id}', '${siteUrl}');` : ""}
    ${pages.map((url, i) => `INSERT INTO project_key_pages (id, project_id, url) VALUES ('${id}-${i}', '${id}', '${url}');`).join("\n")}
  `;
}

async function stored() {
  const result = await client.execute(
    "SELECT project_id, url, inspected_url, verdict, coverage_state, error, inspected_at FROM url_inspections ORDER BY project_id, url",
  );
  return result.rows.map((row) => ({ ...row }));
}

const pass = (url: string) => ({
  url,
  result: {
    indexStatusResult: {
      verdict: "PASS",
      coverageState: "Submitted and indexed",
    },
  },
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.isHosted.mockResolvedValue(false);
  mocks.inspectUrls.mockImplementation((input) =>
    Promise.resolve({ results: input.urls.map(pass) }),
  );
  await client.executeMultiple(`
    DELETE FROM url_inspections; DELETE FROM project_key_pages;
    DELETE FROM gsc_connections; DELETE FROM projects;
  `);
});

describe("runScheduledIndexInspections", () => {
  it("inspects key pages of live connected projects and stores the result", async () => {
    await client.executeMultiple(
      project("a", "sc-domain:a.com", [
        "https://a.com",
        "https://a.com/pricing",
      ]) +
        project("unlinked", null, ["https://u.com"]) +
        project("archived", "sc-domain:z.com", ["https://z.com"], true),
    );

    await Scheduler.runScheduledIndexInspections(NOW);

    expect(mocks.inspectUrls).toHaveBeenCalledTimes(1);
    expect(mocks.inspectUrls).toHaveBeenCalledWith({
      projectId: "a",
      urls: ["https://a.com/", "https://a.com/pricing"],
    });
    expect(await stored()).toEqual([
      expect.objectContaining({
        url: "https://a.com",
        inspected_url: "https://a.com/",
        verdict: "PASS",
        error: null,
        inspected_at: NOW.toISOString(),
      }),
      expect.objectContaining({
        url: "https://a.com/pricing",
        verdict: "PASS",
      }),
    ]);
  });

  it("re-inspects only URLs older than a day, never-inspected first, capped per tick", async () => {
    const pages = Array.from({ length: 10 }, (_, i) => `https://a.com/p${i}`);
    await client.executeMultiple(`
      ${project("a", "sc-domain:a.com", pages)}
      INSERT INTO url_inspections (id, project_id, url, inspected_url, inspected_at)
        VALUES ('fresh', 'a', 'https://a.com/p0', 'https://a.com/p0', '2026-11-01T12:00:00.000Z'),
               ('stale', 'a', 'https://a.com/p1', 'https://a.com/p1', '2026-11-01T09:00:00.000Z');
    `);

    await Scheduler.runScheduledIndexInspections(NOW);

    const urls = mocks.inspectUrls.mock.calls[0]?.[0].urls ?? [];
    expect(urls).toHaveLength(Scheduler.INSPECTIONS_PER_TICK);
    expect(urls).not.toContain("https://a.com/p0");
    // Eight never-inspected pages fill the tick before the stale one.
    expect(urls).not.toContain("https://a.com/p1");
  });

  it("rebases key pages onto a URL-prefix property and stores out-of-property pages as failed", async () => {
    await client.executeMultiple(
      project("n", "https://www.n.com/", [
        "https://n.com/services",
        "https://other.com/x",
      ]) +
        project("b", "https://b.com/blog/", [
          "https://b.com/blog/post",
          "https://b.com/about",
        ]),
    );

    await Scheduler.runScheduledIndexInspections(NOW);

    expect(mocks.inspectUrls).toHaveBeenCalledWith({
      projectId: "n",
      urls: ["https://www.n.com/services"],
    });
    expect(mocks.inspectUrls).toHaveBeenCalledWith({
      projectId: "b",
      urls: ["https://b.com/blog/post"],
    });
    expect(await stored()).toContainEqual(
      expect.objectContaining({
        url: "https://b.com/about",
        error: "URL is outside the Search Console property",
      }),
    );
  });

  it("stores per-URL and whole-batch failures so they back off a day", async () => {
    await client.executeMultiple(
      project("a", "sc-domain:a.com", ["https://a.com/x", "https://a.com/y"]) +
        project("b", "sc-domain:b.com", ["https://b.com/z"]),
    );
    mocks.inspectUrls.mockImplementation((input) =>
      input.projectId === "a"
        ? Promise.resolve({
            results: [
              pass("https://a.com/x"),
              { url: "https://a.com/y", result: null, error: "URL unknown" },
            ],
          })
        : Promise.reject(new Error("grant revoked")),
    );

    await Scheduler.runScheduledIndexInspections(NOW);

    expect(await stored()).toEqual([
      expect.objectContaining({ url: "https://a.com/x", error: null }),
      expect.objectContaining({ url: "https://a.com/y", error: "URL unknown" }),
      expect.objectContaining({
        url: "https://b.com/z",
        error: "grant revoked",
      }),
    ]);
    mocks.inspectUrls.mockClear();
    await Scheduler.runScheduledIndexInspections(
      new Date(NOW.getTime() + 60 * 60_000),
    );
    expect(mocks.inspectUrls).not.toHaveBeenCalled();
  });

  it("does nothing in hosted mode", async () => {
    await client.executeMultiple(
      project("a", "sc-domain:a.com", ["https://a.com"]),
    );
    mocks.isHosted.mockResolvedValue(true);

    await Scheduler.runScheduledIndexInspections(NOW);

    expect(mocks.inspectUrls).not.toHaveBeenCalled();
  });
});
