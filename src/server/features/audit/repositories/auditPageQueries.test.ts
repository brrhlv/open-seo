import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as AuditPageQueriesModule from "./auditPageQueries";

// Real in-memory SQLite: the grouping, counting, ordering and limit are SQL.
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let queries: typeof AuditPageQueriesModule;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  vi.doMock("@/db", () => ({ db: drizzle(client) }));
  await client.executeMultiple(`
    CREATE TABLE audit_pages (id TEXT PRIMARY KEY, audit_id TEXT NOT NULL, url TEXT NOT NULL, status_code INTEGER);
    CREATE TABLE audit_issues (
      id TEXT PRIMARY KEY, audit_id TEXT NOT NULL, page_id TEXT, page_url TEXT NOT NULL,
      issue_type TEXT NOT NULL, severity TEXT NOT NULL, details_json TEXT
    );
    INSERT INTO audit_pages VALUES
      ('p1', 'a1', 'https://a.com/', 200),
      ('p2', 'a1', 'https://a.com/about', 200),
      ('p3', 'a1', 'https://a.com/services', 200),
      ('p4', 'a1', 'https://a.com/zz', 200),
      ('x1', 'a2', 'https://a.com/other-audit', 200);
    INSERT INTO audit_issues VALUES
      ('i1', 'a1', 'p1', 'https://a.com/', 'title-too-long', 'info', '{"length":181}'),
      ('i2', 'a1', 'p3', 'https://a.com/services', 'broken-internal-link', 'critical', '{"target":"/x"}'),
      ('i3', 'a1', 'p3', 'https://a.com/services', 'broken-internal-link', 'critical', '{"target":"/y"}'),
      ('i4', 'a1', 'p3', 'https://a.com/services', 'title-too-long', 'info', NULL),
      ('i5', 'a1', 'p4', 'https://a.com/zz', 'missing-h1', 'warning', NULL),
      ('i6', 'a2', 'x1', 'https://a.com/other-audit', 'missing-h1', 'warning', NULL);
  `);
  // Imported after doMock: the module binds `db` at import time.
  queries = await import("./auditPageQueries");
}, 30_000);

afterAll(() => client.close());

describe("getPageRowsForAudit", () => {
  it("counts issue types per severity, worst pages first, and applies the limit", async () => {
    expect(await queries.getPageRowsForAudit("a1", 3)).toEqual([
      {
        id: "p3",
        url: "https://a.com/services",
        statusCode: 200,
        critical: 1,
        warning: 0,
        info: 1,
      },
      {
        id: "p4",
        url: "https://a.com/zz",
        statusCode: 200,
        critical: 0,
        warning: 1,
        info: 0,
      },
      {
        id: "p1",
        url: "https://a.com/",
        statusCode: 200,
        critical: 0,
        warning: 0,
        info: 1,
      },
    ]);
  });
});

describe("getIssueRowsForAudit", () => {
  it("groups occurrences of one issue type on one page", async () => {
    const rows = await queries.getIssueRowsForAudit("a1");
    expect(rows).toHaveLength(4);
    expect(rows).toContainEqual({
      pageUrl: "https://a.com/services",
      issueType: "broken-internal-link",
      severity: "critical",
      occurrences: 2,
      detailsJson: '{"target":"/x"}',
    });
  });
});
