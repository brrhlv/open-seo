# CLIENT-SBLV-196: `savedKeywords` in the public project summary

Ticket: `vault/7-Systems/tickets/CLIENT-SBLV-196-keyword-research-to-blog-calendar.md`.
Consumer: the SocialBooth LV admin Blog calendar ("Keyword ideas" panel, branch `CLIENT-SBLV-196/blog-keyword-ideas` in socialboothlv-site).

## Goal

The admin needs to read a project's saved keywords (keyword, volume, KD, tags, saved date) with the key and Cloudflare Access path it already uses for the summary. Saved keywords already exist in OpenSEO (`save_keywords` / `list_saved_keywords` MCP tools, the Saved page). Nothing about storage changes; this adds one read-only section to `GET /api/public/v1/projects/{projectId}/summary`.

## Storage (existing, unchanged)

| Table | Role |
|---|---|
| `saved_keywords` | One row per project + keyword + location + language (unique). `created_at` is the saved date (SQLite `current_timestamp`, "YYYY-MM-DD HH:MM:SS" UTC). |
| `keyword_metrics` | Latest cached metrics per project + keyword + location + language: `search_volume`, `keyword_difficulty`, `cpc`, `competition`, `intent`, `monthly_searches` (JSON), `fetched_at`. Joined on all four columns. Written by `save_keywords` when metrics are passed, and by the metrics refresh. |
| `saved_keyword_tags` | Per-project tag names; `normalized_name` = trimmed, single-spaced, lowercased name (unique per project). |
| `saved_keyword_tag_assignments` | keyword ↔ tag (unique pair). |

`KeywordResearchService.getSavedKeywords` already reads all of it in one call (two queries plus a tag lookup). The section reuses it; there is no new repository code.

**No migration, no cron, no DataForSEO call.** Cost: $0/month.

## API contract

New key `savedKeywords` on the summary response. Additive: older consumers ignore it; the admin treats a missing key as "not available yet". Like every section it fails on its own: an exception becomes `{ "error": "internal_error" }` and the other sections still return.

```ts
savedKeywords: {
  /** All saved keywords in the project. */
  totalCount: number;
  /** true when totalCount > keywords.length (the list is capped at 250, newest first). */
  truncated: boolean;
  /** Every tag in the project with its keyword count, by normalized name. */
  tags: { name: string; keywordCount: number }[];
  /** Newest saved first, at most 250. */
  keywords: {
    keyword: string;              // normalized (trimmed, lowercased)
    searchVolume: number | null;  // monthly, for the saved row's location (project market)
    keywordDifficulty: number | null; // 0-100
    cpc: number | null;           // USD
    intent: string | null;        // informational | commercial | transactional | navigational | unknown
    tags: string[];               // tag display names, sorted by normalized name
    savedAt: string | null;       // ISO 8601 UTC
    metricsFetchedAt: string | null; // ISO 8601 UTC; null when no metrics were stored
    locationCode: number;         // e.g. 2840
    languageCode: string;         // e.g. "en"
  }[];
} | { error: string }
```

Example (SBLV after the seed):

```json
"savedKeywords": {
  "totalCount": 62,
  "truncated": false,
  "tags": [
    { "name": "blog-idea", "keywordCount": 62 },
    { "name": "cluster:holiday-party", "keywordCount": 7 },
    { "name": "page:/holiday-party-photo-booth-las-vegas", "keywordCount": 5 }
  ],
  "keywords": [
    {
      "keyword": "casino night event",
      "searchVolume": 1000,
      "keywordDifficulty": 0,
      "cpc": null,
      "intent": "informational",
      "tags": ["blog-idea", "cluster:corporate-events", "page:/corporate-events"],
      "savedAt": "2026-11-03T18:00:00.000Z",
      "metricsFetchedAt": "2026-11-03T07:27:39.000Z",
      "locationCode": 2840,
      "languageCode": "en"
    }
  ]
}
```

Why the whole list instead of a tag filter: the summary response is cached per project + range (15 minutes, Workers Cache), so a query-string filter would need its own cache key. 250 rows is a few KB; consumers filter by tag. A project that outgrows 250 shows `truncated: true` and a follow-up adds a dedicated endpoint.

### Tag conventions (SBLV, set by the seed; the API does not interpret them)

- `blog-idea`: a keyword meant to become a blog post.
- `cluster:<slug>`: the topic cluster (`corporate-events`, `holiday-party`, `trade-shows`, …).
- `page:<path>`: the money page the post should link to.
- `priority:p1|p2|p3`: the research priority (p1 = seasonal or best volume-to-difficulty).

## Code

| File | Change |
|---|---|
| `src/server/features/public-api/sections/savedKeywords.ts` | New. `getSavedKeywordsSection(projectId)`: calls `KeywordResearchService.getSavedKeywords({ page: 1, pageSize: 250, sort: "createdAt", order: "desc" })`, maps rows to the contract, ISO timestamps through `toIsoTimestamp`. |
| `src/server/features/public-api/sections/savedKeywords.test.ts` | New. Repository mocked (as `PublicSummaryService.test.ts` does): mapping, ISO conversion, the 250 cap and `truncated`, empty project. |
| `src/server/features/public-api/PublicSummaryService.ts` | Four lines: import, one entry in the `allSettled` list, one destructured name, one `unwrap` line. |
| `src/server/features/public-api/PublicSummaryService.test.ts` | Mock `KeywordResearchRepository`; add `savedKeywords` to the full-shape assertion. |
| `scripts/saved-keywords-seed-sql.ts` | New CLI. Turns a candidates JSON file (`{ candidates: [{ keyword, usVolume, keywordDifficulty, intent, cpc, monthlySearches, tags }] }`) into idempotent D1 SQL for one project. Writes nothing itself. |

The SBLV seed SQL generated by the script lives with the research, not in this public repo: `socialbooth-lv/_meta/reports/SBLV-196/seed-saved-keywords.sql`.

### Seed SQL semantics

Per keyword (location 2840, language `en`):

1. `INSERT OR IGNORE INTO saved_keywords` (unique key makes a re-run a no-op).
2. `INSERT INTO keyword_metrics … ON CONFLICT (project_id, keyword, location_code, language_code) DO UPDATE` — the same upsert `save_keywords` does.
3. `INSERT OR IGNORE INTO saved_keyword_tags` per distinct tag (normalized name as `saveKeywords` computes it).
4. `INSERT OR IGNORE INTO saved_keyword_tag_assignments SELECT …` joined by project + keyword and project + normalized tag name, so it works whether the keyword row was new or already there.

It only adds; it never deletes keywords or tags. It is equivalent to calling `save_keywords` with `tagMode: "append"`.

## UI states (OpenSEO)

None. The Saved page already shows the keywords and tags; nothing in the OpenSEO UI changes.

## Test plan

- Unit: `sections/savedKeywords.test.ts`, the updated `PublicSummaryService.test.ts`.
- Seed: run the generated SQL twice against a local D1 (`wrangler d1 migrations apply DB --local`, then `wrangler d1 execute DB --local --file …`) with a stub project row; counts must match after both runs (idempotent).
- Checks: typecheck, `vitest run` (baseline: 1 known failure in `samSkills.test.ts`), oxlint, `vite build --mode selfhost`.

## Rollout

1. Merge, deploy (alchemy, per `reference_openseo_setup`). No migration.
2. Run the seed against production D1 through the CF API (coordinator; this branch does not write D1):
   `POST /accounts/{account}/d1/database/3c6f2f61-8748-4944-b900-2f857b02059b/query` with the SQL from `seed-saved-keywords.sql` (one statement per request, or the file split on `;\n`).
3. Verify: `SELECT count(*) FROM saved_keywords WHERE project_id = 'c65ed7c9-ee05-4b6d-a61f-8817c7a003ae'` = 62 (plus any saved before), 30 tags, 248 tag assignments; then `GET …/summary?range=last_28_days` shows `savedKeywords.totalCount`. The summary is edge-cached 15 minutes and the admin caches 10 minutes, so allow up to 25 minutes before the panel fills.
4. No backfill, no first run: the data is live once the rows exist.
