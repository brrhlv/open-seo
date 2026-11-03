import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { sort } from "remeda";
import { describe, expect, it } from "vitest";
import { buildSavedKeywordsSeedSql } from "./savedKeywordsSeedSql";

const PROJECT = "proj-1";

const CANDIDATES = [
  {
    keyword: "  Law Firm's Holiday  Party ",
    usVolume: 90,
    keywordDifficulty: 4,
    cpc: 1.5,
    intent: "commercial",
    monthlySearches: [{ year: 2026, month: 10, searchVolume: 90 }],
    tags: ["blog-idea", "page:/law-firm's-events"],
  },
  {
    keyword: "casino night event",
    usVolume: 1000,
    keywordDifficulty: null,
    intent: "not-an-intent",
    tags: ["Blog-Idea", "cluster:corporate-events"],
  },
];

function build(fetchedAt = "2026-11-03T07:27:39.000Z") {
  let n = 0;
  return buildSavedKeywordsSeedSql({
    candidates: CANDIDATES,
    projectId: PROJECT,
    locationCode: 2840,
    languageCode: "en",
    fetchedAt,
    newId: () => `id-${++n}`,
  });
}

/** A fresh SQLite database with the D1 migrations applied and one project. */
function migratedDb() {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync("drizzle").filter((f) => f.endsWith(".sql"));
  for (const file of sort(files, (a, b) => a.localeCompare(b))) {
    db.exec(
      readFileSync(`drizzle/${file}`, "utf8").replaceAll(
        "--> statement-breakpoint",
        "",
      ),
    );
  }
  db.exec(
    `INSERT INTO organization (id, name, slug, created_at) VALUES ('org-1', 'o', 'o', 0);
     INSERT INTO projects (id, organization_id, name) VALUES ('${PROJECT}', 'org-1', 'p');`,
  );
  return db;
}

const run = (db: DatabaseSync, sql: string) => {
  for (const line of sql.split("\n"))
    if (line.startsWith("INSERT")) db.exec(line);
};
const count = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("buildSavedKeywordsSeedSql", () => {
  it("normalizes, quotes and orders the statements", () => {
    const { sql, keywordCount, tagCount } = build();
    expect({ keywordCount, tagCount }).toEqual({
      keywordCount: 2,
      tagCount: 3,
    });
    expect(sql).toMatchSnapshot();
  });

  it("is idempotent and never rolls back fresher metrics", () => {
    const db = migratedDb();
    run(db, build().sql);
    run(db, build().sql);
    expect(
      [
        "saved_keywords",
        "keyword_metrics",
        "saved_keyword_tags",
        "saved_keyword_tag_assignments",
      ].map((t) => count(db, t)),
    ).toEqual([2, 2, 3, 4]);

    db.exec(
      `UPDATE keyword_metrics SET search_volume = 5000, fetched_at = '2026-12-01T00:00:00.000Z' WHERE keyword = 'casino night event'`,
    );
    run(db, build().sql);
    expect(
      db
        .prepare(
          `SELECT search_volume AS v FROM keyword_metrics WHERE keyword = 'casino night event'`,
        )
        .get(),
    ).toEqual({ v: 5000 });

    run(db, build("2027-01-01T00:00:00.000Z").sql);
    expect(
      db
        .prepare(
          `SELECT search_volume AS v FROM keyword_metrics WHERE keyword = 'casino night event'`,
        )
        .get(),
    ).toEqual({ v: 1000 });
  });
});
