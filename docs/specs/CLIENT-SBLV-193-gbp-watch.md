# CLIENT-SBLV-193: Google Business Profile watch

Status: plan and spec, 2026-11-02. Ticket: `vault/7-Systems/tickets/CLIENT-SBLV-193-gbp-watch-in-admin.md`.
Admin consumer: `socialboothlv-site` `docs/specs/CLIENT-SBLV-193-gbp-watch.md`.

## Why

SBLV's GBP categories drifted without anyone noticing (found 2026-11-02; a "Google updates (1)" flag was seen in July). The June audit planned a weekly persistence check that was never built. OpenSEO already wraps the four DataForSEO business endpoints but stores nothing. This adds a weekly, stored snapshot per project, a diff against the last snapshot and against an accepted state, two MCP tools and a `gbp` section in the public summary.

Built on the PAI-217 model (AI visibility): a config table, a snapshots table, a due-row scheduler on the existing `*/5` cron, free MCP read, paid MCP run, additive summary section.

## Live findings from the fixture pull (2026-11-03 07:20 UTC, $0.0138)

- Profile (`my_business_info/live`, `cid:5590594803775798319`): primary **Photo booth**; additional **Balloon artist, Event management company, Event planner, Party equipment rental service**; website `https://socialboothlv.com/`; hours 09:00 to 21:00 every day; 5.0 from 113 reviews; claimed; 115 photos.
- **Drift on day one:** "Party equipment rental service" is still an additional category. Bryan's accepted state (2026-11-02) says no party-rental category. The first snapshot will report it.
- Q&A (`questions_and_answers/live`): status 40102 "No Search Results", still billed $0.0054. Google retired the Q&A module on Maps in late 2025, so this is expected to stay empty. Kept in the snapshot so a revived module shows up, and switchable off per project (`include_questions`).
- Reviews (`reviews/task_post`, depth 20, high priority): settled within 6 s. Newest review 2026-10-29; 3 of the newest 5 have no owner reply.
- Owner updates were not pulled (the ticket's paid allowance covered profile, reviews and Q&A); the fixture follows the documented `my_business_updates` item shape.

## Data model (migration in its own final commit)

D1 `drizzle/0046_gbp_watch.sql` and Postgres `drizzle-pg/0024_gbp_watch.sql`, generated with `db:generate`. Schema files `src/db/gbp-watch.schema.ts` and `src/db/pg/gbp-watch.schema.ts`, kept in parity by `schema-parity.test.ts`.

### `gbp_configs` (one per project)

| column | type | notes |
|---|---|---|
| `id` | text PK | uuid |
| `project_id` | text FK projects, cascade, unique | |
| `place_id` | text null | `ChIJuy0JGkfryIARL3wzklrIlU0` |
| `cid` | text null | `5590594803775798319`; preferred identifier (`cid:` keyword prefix) |
| `listing_id` | text null | GBP manager listing id `14154039352732233380`, for the edit-profile link only |
| `expected_json` | text not null default `'{}'` | the accepted state, below |
| `include_questions` | boolean not null default true | Q&A costs $0.0054 a run; Google retired the module |
| `schedule_interval` | text enum `weekly`/`manual`, default `weekly` | |
| `is_active` | boolean not null default true | |
| `last_checked_at`, `next_check_at`, `last_error` | text null | same roles as `ai_visibility_configs` |
| `created_at` | text not null default now | |

Indexes: unique `(project_id)`, `(is_active, next_check_at)` for the due query. At least one of `cid` / `place_id` is required (validated in the service; a CHECK would need a parity-tested name on both dialects for no gain).

`expected_json` (Zod `gbpExpectedSchema`, validated on write, `safeParse` on read so a bad row degrades to "no expectations"):

```json
{
  "primaryCategory": "Photo booth",
  "allowedAdditionalCategories": ["Balloon artist", "Event management company", "Event planner"],
  "forbiddenCategories": ["Wedding service", "Wedding photographer", "Photographer", "Photography service", "Party equipment rental service"],
  "website": "https://socialboothlv.com/",
  "hours": { "monday": ["09:00-21:00"], "tuesday": ["09:00-21:00"], "wednesday": ["09:00-21:00"], "thursday": ["09:00-21:00"], "friday": ["09:00-21:00"], "saturday": ["09:00-21:00"], "sunday": ["09:00-21:00"] }
}
```

Every key is optional. Category names compare case-insensitively after trimming. Websites compare by scheme, host (both lowercased) and path (case kept), with one trailing slash and `utm_*` parameters ignored; `http://` vs `https://` is drift, which is what the June audit fixed. Hours compare as the normalized map with each day's slots sorted (a day missing or `[]` = closed).

### `gbp_snapshots` (one row per run)

| column | type | notes |
|---|---|---|
| `id` | integer PK autoincrement (serial on PG) | |
| `project_id` | text FK cascade | |
| `identifier` | text null | `cid:<cid>` or `place_id:<id>` the run used; a row with a different identifier than the one before starts a new baseline (no diff, nothing new, no rating change) |
| `title`, `primary_category`, `website`, `phone`, `address`, `description` | text null | profile fields |
| `additional_categories_json` | text not null default `'[]'` | string array, Google's order |
| `hours_json` | text null | normalized `{ day: ["HH:MM-HH:MM"] }`; null when Google shows no hours |
| `latitude`, `longitude` | real null | the profile's pin (Q&A needs a coordinate) |
| `rating` | real null, `review_count` integer null, `total_photos` integer null, `is_claimed` boolean null | |
| `reviews_json` | text null | newest reviews collected this run (depth 10), each with `isNew`; null = not collected this run |
| `questions_json` | text null | Q&A rows collected; null = not collected (off, or failed) |
| `updates_json` | text null | owner posts collected (depth 10), each with `isNew`; null = not collected |
| `changes_json` | text not null default `'[]'` | field changes vs the previous snapshot, computed at write |
| `billing_cost_usd` | real not null default 0 | real DataForSEO cost via the client's `onCost` hook |
| `captured_at` | text not null default now | |

Index `(project_id, captured_at)`.

"New since the last snapshot": a review or post is new when its id (review: `review_id`; post: `url`, falling back to `timestamp + text`) is not in the most recent earlier snapshot that collected that list. The first snapshot is the baseline: nothing is new and `changes` is empty. A run whose reviews task did not settle stores `reviews_json = null`; the next run compares against the last snapshot that has reviews, so a gap never marks old reviews as new.

`changes` are stored (they are facts about two snapshots and never change). `driftFromExpected` is computed at read time against the current `expected_json`, so editing the accepted state clears or raises drift without a new paid run.

Omitted fields: DataForSEO sometimes leaves out `work_time`, `is_claimed` or `additional_categories` for a profile that has them. When the new value is missing or empty and the previous one was set, the run keeps (and stores) the previous value, so it never reports "Hours: … to none" one week and back the next. A real new value always wins.

Watched fields for `changes`: `title`, `primaryCategory`, `additionalCategories`, `website`, `phone`, `address`, `hours`, `isClaimed`. Not watched: rating and review count (reported as a change line, not an alert), description, photos.

## Run (`GbpWatchService.runSnapshot`)

1. Load the config; `NOT_FOUND` when none. Without `force`, a snapshot captured in the last hour returns `already_captured` (no DataForSEO call).
2. Through one metered client with an `onCost` accumulator, first the profile: `myBusinessInfo({ keyword: "cid:<cid>" | "place_id:<id>", locationCode, languageCode })` (the project's market). No profile (null item or a failed call) = `UPSTREAM_UNAVAILABLE`, nothing stored, `last_error` set, and no further calls are made.
3. Then in parallel:
   - `questionsAnswers({ keyword, locationCoordinate: "<profile lat>,<profile lng>,1000" })` when `include_questions` (the endpoint requires a coordinate, which only the profile knows);
   - `reviewsTaskPost({ cid | placeId, depth: 10, sortBy: "newest" })` and `updatesTaskPost({ keyword, depth: 10 })`, high priority.
4. Poll both tasks together, up to 6 times, 4 s apart (the MCP tools' window). A task still pending after that, or any of the three calls failing, is stored as `null` for this run; it never fails the run.
5. Build the row: normalize the profile, mark new reviews and posts against the previous lists, diff the watched fields against the previous snapshot, insert, update `last_checked_at` and clear `last_error`.

## Schedule

Weekly, Mondays 14:00 UTC (06:00 PT / 07:00 PDT), on the existing `*/5` trigger: `runScheduledGbpSnapshots()` runs after the AI-visibility loop in `src/server.ts`, one due config per tick (a run is 4 DataForSEO calls plus up to 12 polls; Workers Free caps an invocation at 50 subrequests and the rank loop shares it). Claim by compare-and-set on `next_check_at` (same as AI visibility). A failed Monday run retries once, 6 hours later; a failed retry records `last_error` and waits for the next Monday (the claim already moved `next_check_at` there). `runSnapshot` never throws once the snapshot row is saved, so a retry never pays twice. No new cron expression.

## Cost

Measured 2026-11-03 per call: profile $0.0054, Q&A $0.0054 (billed even when empty), reviews $0.0015 per 10 at high priority. Owner updates estimated at the same $0.0015 per 10 (not measured; the stored `billing_cost_usd` is the real figure after the first run).

| | per run | per month (4.35 weekly runs) |
|---|---|---|
| profile + reviews 10 + updates 10 | $0.0084 | $0.037 |
| + Q&A | $0.0138 | **$0.060** |
| all 9 projects with Q&A | | $0.54 |

Rollout is SBLV only: about **$0.06 a month**. Turning Q&A off (`include_questions: false`) saves $0.023 a month per project; recommended once a month of runs confirms Google returns nothing.

## MCP tools

- `get_gbp_watch` (read-only, free): config, expected state, latest profile, rating and review count with the change since the previous snapshot, latest 5 reviews, unanswered Q&A, recent owner posts, `changes` (last 90 days) and `driftFromExpected`. No DataForSEO call.
- `run_gbp_snapshot` (spends credits, about $0.014; the description says so): snapshot now. `force` re-runs inside the one-hour guard.
- `set_gbp_watch` (writes config, free): create or update the project's watch (`cid` / `placeId` / `listingId`, `expected`, `includeQuestions`, `scheduleInterval`, `active`). Needed for rollout without hand-written SQL; a weekly watch's first run is the next Monday 14:00 UTC.

## Public summary: `gbp` section (additive)

`GET /api/public/v1/projects/{id}/summary` gains `gbp`, built in `src/server/features/public-api/sections/gbp.ts` from stored rows only (never metered). It fails alone as `{ "error": "internal_error" }` like every other section.

```ts
type GbpSummary = {
  tracked: boolean;                 // false: no config, or inactive
  placeId: string | null;
  cid: string | null;
  listingId: string | null;
  lastCheckedAt: string | null;     // ISO
  nextCheckAt: string | null;       // ISO, null for manual
  lastError: string | null;
  profile: null | {
    capturedAt: string;             // ISO
    title: string | null;
    primaryCategory: string | null;
    additionalCategories: string[];
    website: string | null;
    phone: string | null;
    address: string | null;
    hours: Record<"monday"|"tuesday"|"wednesday"|"thursday"|"friday"|"saturday"|"sunday", string[]> | null;
    hoursText: string | null;       // "Every day 09:00-21:00", "Mon-Fri 09:00-17:00, Sat-Sun closed"
    isClaimed: boolean | null;
    totalPhotos: number | null;
    mapsUrl: string | null;         // https://www.google.com/maps?cid=<cid>
  };
  rating: {
    value: number | null;
    reviewCount: number | null;
    previousValue: number | null;       // previous snapshot; null on the first
    previousReviewCount: number | null;
    valueChange: number | null;         // value - previousValue, 2 decimals
    reviewCountChange: number | null;
    comparedTo: string | null;          // previous snapshot capturedAt, ISO
  };
  latestReviews: Array<{               // newest first, at most 5
    reviewId: string | null;
    author: string | null;
    rating: number | null;
    text: string | null;
    publishedAt: string | null;        // ISO
    ownerReplied: boolean;
    ownerRepliedAt: string | null;
    isNew: boolean;                    // first seen in the latest snapshot
  }>;
  newReviewCount: number | null;       // isNew among the latest snapshot's reviews; null when it did not collect reviews
  questionsAvailable: boolean;         // false when Q&A is off or Google returned no Q&A module
  unansweredQuestions: Array<{ questionId: string | null; text: string; author: string | null; askedAt: string | null }>;
  ownerUpdates: { latestPostedAt: string | null; newCount: number; recent: Array<{ postedAt: string | null; text: string | null; url: string | null }> } | null;  // null: never collected
  changes: Array<{ field: GbpField; from: string | null; to: string | null; detectedAt: string }>;  // last 90 days, newest first, at most 20
  driftFromExpected: Array<{
    field: "primaryCategory" | "additionalCategories" | "website" | "hours";
    rule: "primary_category" | "forbidden_category" | "unexpected_category" | "website" | "hours";
    expected: string | null;           // display text of the accepted value
    actual: string | null;
    since: string;                     // ISO, first snapshot in the current unbroken run showing it
  }>;
};
type GbpField = "title" | "primaryCategory" | "additionalCategories" | "website" | "phone" | "address" | "hours" | "isClaimed";
```

`changes.from` / `to` are display strings: categories joined with ", ", hours as `hoursText`, booleans as "yes"/"no".

Example (SBLV after the first run, trimmed):

```json
{
  "tracked": true,
  "placeId": "ChIJuy0JGkfryIARL3wzklrIlU0",
  "cid": "5590594803775798319",
  "listingId": "14154039352732233380",
  "lastCheckedAt": "2026-11-09T14:00:41.000Z",
  "nextCheckAt": "2026-11-16T14:00:00.000Z",
  "lastError": null,
  "profile": {
    "capturedAt": "2026-11-09T14:00:41.000Z",
    "title": "Social Booth LV",
    "primaryCategory": "Photo booth",
    "additionalCategories": ["Balloon artist", "Event management company", "Event planner", "Party equipment rental service"],
    "website": "https://socialboothlv.com/",
    "phone": "+1702-291-8712",
    "address": "8400 Surfs Up Dr, Las Vegas, NV 89128",
    "hours": { "monday": ["09:00-21:00"], "tuesday": ["09:00-21:00"], "wednesday": ["09:00-21:00"], "thursday": ["09:00-21:00"], "friday": ["09:00-21:00"], "saturday": ["09:00-21:00"], "sunday": ["09:00-21:00"] },
    "hoursText": "Every day 09:00-21:00",
    "isClaimed": true,
    "totalPhotos": 115,
    "mapsUrl": "https://www.google.com/maps?cid=5590594803775798319"
  },
  "rating": { "value": 5, "reviewCount": 113, "previousValue": null, "previousReviewCount": null, "valueChange": null, "reviewCountChange": null, "comparedTo": null },
  "latestReviews": [
    { "reviewId": "Ci9DQUlRQUNvZENodHljRjlvT2xoQ00xQlpTMUIzWWt0RlNFWTJOSGhRWWxrNU5sRRAB", "author": "Abigail Orberg", "rating": 5, "text": "Christine was amazing to work with from start to finish...", "publishedAt": "2026-10-29T14:38:59.000Z", "ownerReplied": false, "ownerRepliedAt": null, "isNew": false }
  ],
  "newReviewCount": 0,
  "questionsAvailable": false,
  "unansweredQuestions": [],
  "ownerUpdates": { "latestPostedAt": null, "newCount": 0, "recent": [] },
  "changes": [],
  "driftFromExpected": [
    { "field": "additionalCategories", "rule": "forbidden_category", "expected": "Not listed", "actual": "Party equipment rental service", "since": "2026-11-09T14:00:41.000Z" }
  ]
}
```

Untracked project: `{ "tracked": false, "placeId": null, "cid": null, "listingId": null, "lastCheckedAt": null, "nextCheckAt": null, "lastError": null, "profile": null, "rating": { all null }, "latestReviews": [], "newReviewCount": 0, "questionsAvailable": false, "unansweredQuestions": [], "ownerUpdates": null, "changes": [], "driftFromExpected": [] }`. A tracked project before its first run has `profile: null`.

## Files

- `src/db/gbp-watch.schema.ts`, `src/db/pg/gbp-watch.schema.ts`, one export line each in `src/db/d1/schema.ts`, `src/db/pg/schema.ts`, the barrel `src/db/schema.ts` and `schema-parity.test.ts`.
- `src/server/features/gbp-watch/gbpWatchModel.ts`: pure normalization and diffs (profile, hours, reviews, Q&A, posts, `changes`, `driftFromExpected`, `hoursText`), Zod `gbpExpectedSchema`.
- `src/server/features/gbp-watch/repositories/GbpWatchRepository.ts`, `services/GbpWatchService.ts`, `services/scheduledGbpSnapshots.ts`.
- `src/server/mcp/tools/gbp-watch-tools.ts` (three tools), registered in `src/server/mcp/server.ts`.
- `src/server/features/public-api/sections/gbp.ts`, registered in `PublicSummaryService.ts` (one import, one `allSettled` entry, one `unwrap` line).
- `src/server.ts`: one `try` block after the AI-visibility block.

## Test plan

- `gbpWatchModel.test.ts` (pure, fixtures from the live pull in `__fixtures__/sblv-*.json`): profile normalization (categories, hours map, website, rating); `hoursText` grouping; drift: forbidden category found in the live fixture, unexpected category, primary mismatch, website scheme change, hours change, case-insensitive match, `since` walks back the unbroken run; `changes` for categories, hours and website; reviews `isNew` against the previous list and the null-gap case; first snapshot has no changes and nothing new.
- `GbpWatchService.test.ts` (in-memory SQLite from the shipped migration, DataForSEO mocked like `AiVisibilityService.test.ts`): run stores one row with the summed cost; one-hour guard skips DataForSEO; a reviews task that never settles stores `reviews_json = null` and the run succeeds; a failed profile stores nothing and sets `last_error`; the second run diffs against the first.
- `scheduledGbpSnapshots.test.ts`: one due config per tick, claim moves `next_check_at` to the next Monday 14:00 UTC, failure sets `last_error` and retries in 6 h.
- `gbp-watch-tools.test.ts`: `get_gbp_watch` spends nothing; `run_gbp_snapshot` description carries the cost; `set_gbp_watch` rejects a config with neither cid nor placeId.
- `PublicSummaryService.test.ts`: `gbp` present and failing alone.
- Gate: `tsc --noEmit`, `vitest run` (baseline 1 known failure, `samSkills.test.ts`), `oxlint --type-aware`, `vite build --mode selfhost` (then restore `src/routeTree.gen.ts`).

## Rollout (coordinator)

1. Merge after the other wave branches; regenerate the migration if `0046` / `0024` collide.
2. Deploy (chained alchemy form in `reference_openseo_setup.md`), then apply `drizzle/0046_gbp_watch.sql` to D1 `3c6f2f61-8748-4944-b900-2f857b02059b`.
3. Create the SBLV watch: MCP `set_gbp_watch` with the SBLV identifiers and the `expected` JSON above, or the D1 insert in the appendix.
4. First run: MCP `run_gbp_snapshot` for SBLV (about $0.014), or set `next_check_at` to now and let the `*/5` tick take it. Check `get_gbp_watch` shows the party-rental drift.
5. Then deploy the admin branch. Its card and alert read `gbp` when present and say "not available yet" when absent, so the order between the two deploys is not critical.

## Appendix: D1 insert for step 3

```sql
INSERT INTO gbp_configs (id, project_id, place_id, cid, listing_id, expected_json, include_questions, schedule_interval, is_active, next_check_at)
VALUES (lower(hex(randomblob(16))), 'c65ed7c9-ee05-4b6d-a61f-8817c7a003ae', 'ChIJuy0JGkfryIARL3wzklrIlU0', '5590594803775798319', '14154039352732233380',
  '<expected JSON above, one line>', 1, 'weekly', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
```

## Decisions for Bryan

1. **Remove "Party equipment rental service" from the SBLV profile?** It is live today and conflicts with the accepted state. Until it is removed (or the accepted state changes), the admin shows a drift alert.
2. Are "Balloon artist" and "Event planner" accepted secondaries? The seed allows them; dropping them from `allowedAdditionalCategories` makes them drift.
3. Keep Q&A on for the first month, then turn it off? Google returns no Q&A module today.
