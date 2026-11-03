/**
 * Turn a candidates JSON file into idempotent D1 SQL that saves the keywords,
 * their metrics and their tags to one project (CLIENT-SBLV-196). Equivalent to
 * `save_keywords` with tagMode "append": it only adds rows, never deletes, and
 * a metrics row is only replaced by one with a later fetchedAt.
 * The script writes the SQL to a file and touches no database; apply it
 * yourself (local: `wrangler d1 execute DB --local --file <out>`; production:
 * the CF D1 query API, one statement per line).
 * The SQL is built by src/server/features/keywords/savedKeywordsSeedSql.ts.
 *
 * Input: { candidates: [{ keyword, usVolume?, keywordDifficulty?, cpc?,
 *   intent?, monthlySearches?: [{ year, month, searchVolume }], tags: string[] }] }
 *
 * Usage:
 *   pnpm exec tsx scripts/saved-keywords-seed-sql.ts \
 *     --input=keyword-ideas.json --projectId=<uuid> --out=seed.sql \
 *     [--location=2840] [--language=en] [--fetchedAt=2026-11-03T07:27:39.000Z]
 */

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import {
  buildSavedKeywordsSeedSql,
  type SeedCandidate,
} from "../src/server/features/keywords/savedKeywordsSeedSql";
import { parseArgs } from "./cli-utils";

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { input, projectId, out } = args;
  if (!input || !projectId || !out) {
    throw new Error("Required: --input=<json> --projectId=<uuid> --out=<sql>");
  }
  const doc = JSON.parse(readFileSync(input, "utf8")) as {
    candidates: SeedCandidate[];
  };
  const result = buildSavedKeywordsSeedSql({
    candidates: doc.candidates,
    projectId,
    locationCode: Number(args.location ?? 2840),
    languageCode: args.language ?? "en",
    fetchedAt: args.fetchedAt ?? new Date().toISOString(),
  });
  writeFileSync(out, result.sql);
  console.log(
    `Wrote ${result.statementCount} statements (${result.keywordCount} keywords, ${result.tagCount} tags) to ${out}`,
  );
}

main();
