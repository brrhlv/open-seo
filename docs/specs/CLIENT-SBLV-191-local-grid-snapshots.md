# CLIENT-SBLV-191: persisted Maps rank grid (`localGrid`)

Status: spec and plan, 2026-11-02. Branch `CLIENT-SBLV-191/local-grid-snapshots`.
Consumer: SocialBooth LV admin, Reports → SEO (spec in that repo, same ticket id).
Model: PAI-217 (AI visibility): tracker config, snapshot rows, monthly cron, a free read tool, a paid run tool, an additive summary section.

## 1. Why

`get_local_rank_grid` is one-shot: 9 Maps searches around a coordinate, a rendered table, nothing stored. The SBLV admin wants the grid as a monthly trend per keyword (SoLV, ARP, ATRP and their change), so the grid must be stored and exposed in the public summary.

## 2. Plan

1. **Extract the grid core** from `mcp/tools/local-seo-tools.ts` into `features/local-grid/services/localRankGrid.ts`: grid points, the spacing-derived zoom, matching, the batched search, and the summary. `get_local_rank_grid` imports it and keeps its contract; its output gains additive fields only (`topCompetitor` per point, `solvPct` and `atrp` in `summary`).
2. **Schema** (D1 + Postgres parity), four tables, §4.
3. **Service** `LocalGridService`: `createTracker`, `runKeyword`, `runCheck` (all due keywords), `getLatest`.
4. **Scheduler** `runScheduledLocalGridChecks()` inside the existing `scheduled` dispatch on the `*/5` cron. No new cron expression.
5. **MCP tools** `create_local_grid_tracker`, `run_local_grid`, `get_local_grid`.
6. **Public summary** section `localGrid` in its own module `public-api/sections/localGrid.ts`, registered with one line in `PublicSummaryService.ts`.
7. Migration in its own final commit (`drizzle/0046_*`, `drizzle-pg/0024_*`; the coordinator may renumber).

## 3. Matching rule

The stored tracker matches the business **by `place_id` or `cid` only**. A title is a label for display, never a match key (two businesses named "Social Booth…" exist in Las Vegas: Social Booth LV and The Social Booth Co). The one-shot tool keeps its optional `name` fallback for ad-hoc use; the persisted tracker requires `placeId` or `cid`.

SBLV: place_id `ChIJuy0JGkfryIARL3wzklrIlU0`, CID `5590594803775798319`, center `36.2108236,-115.2695665` (the GBP pin).

## 4. Data model

```
local_grid_configs            one tracker per project
  id text pk
  project_id text fk→projects cascade, unique
  target_name text null        display label only
  target_place_id text null    match key
  target_cid text null         match key (at least one of place_id / cid required by the service)
  center_latitude real not null
  center_longitude real not null
  grid_size integer not null default 3      3 or 5
  spacing_km real not null default 2
  device text enum(desktop, mobile) not null default 'mobile'
  language_code text not null default 'en'
  schedule_interval text enum(monthly, manual) not null default 'monthly'
  is_active boolean not null default true
  last_checked_at text null
  next_check_at text null
  lease_until text null        a run in progress (cron or MCP) holds the tracker until then (10 min)
  last_error text null
  created_at text not null default now
  index (is_active, next_check_at)

local_grid_keywords           the keywords a tracker runs
  id text pk
  config_id text fk→local_grid_configs cascade
  keyword text not null        stored lowercased (so is the snapshot keyword)
  attempts integer not null default 0, attempt_period text null
                               failed or degraded runs this month; 3 and the keyword waits for next month
  created_at text not null default now
  unique (config_id, keyword)

local_grid_snapshots          one row per (project, keyword, UTC month)
  id integer pk autoincrement (serial on PG)
  project_id text fk→projects cascade
  keyword text not null        text, not an fk: history survives removing a keyword
  period text not null         YYYY-MM
  center_latitude real, center_longitude real, grid_size integer, spacing_km real, zoom integer, device text
                               the run's own geometry, so a later config change cannot relabel old rows
  points_searched integer, points_found integer, points_failed integer, top3_count integer, top10_count integer
                               over a third of points failed = stored but not final: retried this month
  solv_pct real null           share of local voice: top-3 points / points searched × 100
  arp real null                average rank where found
  atrp real null               average rank over all searched points, not-found = depth + 1 (21)
  matched_title text null, matched_place_id text null, matched_cid text null
  billing_cost_usd real not null default 0  accumulates on a forced re-run
  captured_at text not null default now
  unique (project_id, keyword, period)
  index (project_id, captured_at)

local_grid_cells              one row per grid point of a snapshot
  id integer pk autoincrement (serial on PG)
  snapshot_id integer fk→local_grid_snapshots cascade
  row integer, col integer     row 0 = north
  latitude real, longitude real
  rank integer null            our rank there; null = not in the top 20
  results_count integer null   null when the point's search failed
  competitor_title text null   best-ranked business that is not us
  competitor_cid text null
  competitor_rank integer null
  error boolean not null default false
  unique (snapshot_id, row, col)
```

Why four tables, not two: the ticket named configs and snapshots. Keywords and cells are separate tables because AGENTS.md forbids encoding relational data in JSON; `rank_tracking_keywords` is the same shape. A re-run in the same month replaces the snapshot's cells (delete + insert) and upserts the snapshot.

Failed points: a point whose search fails is stored with `error = true` and counts in `points_searched`; it is excluded from ARP/ATRP/SoLV denominators. A run where every point fails stores nothing and raises (same as the one-shot tool).

## 5. Cadence and cost

- **Monthly, on the 2nd at 07:00 UTC** (AI visibility owns the 1st). `next_check_at` moves to the next month's 2nd once every keyword has this month's row.
- **One tracker per `*/5` tick, up to 75 Maps calls.** A keyword is 9 Maps calls on 3×3 or 25 on 5×5, batched 3 at a time. The account is on Workers Paid (since 2026-10-09, default limits), so a tick grids all of SBLV's three 3×3 keywords at once; a tracker with keywords left continues on the next tick.
- **Call budget:** a run (cron tick or MCP call) makes at most 75 Maps calls: `keywordsPerRun = max(1, floor(75 / gridSize²))`, so 8 keywords on 3×3 (72 calls) or 3 on 5×5 (75 calls). Both grid sizes are accepted.
- **Lease:** cron and `run_local_grid` both take `lease_until` by compare-and-set; a held tracker is skipped by cron and refused to MCP. The run sets `next_check_at` itself: `now` while untried keywords remain, `now + 6 h` while only retries remain, else the next 2nd. A whole-run failure (credits, auth) sets `last_error` and retries in 6 hours.
- **Retries:** a keyword whose grid throws, or whose snapshot has over a third of its points failed, counts an attempt and goes behind untried keywords; after 3 attempts in a month it waits for next month, so it cannot starve the others.
- **Cost:** a 3×3 grid is **9 SERP calls per keyword**. Maps live advanced is $0.002 per call (verified 2026-11-02: 9 calls, $0.018). So $0.018 per keyword per month; SBLV's three keywords = **$0.054/month** ($0.65/year). A 5×5 grid is 25 calls ≈ $0.05 per keyword per run. SBLV stays 3×3 at 2 km (cost decision). Self-host: 1 credit = $0.001, so 18 credits per 3×3 keyword.
- MCP runs are free when the month is already captured (unless `force`).

## 6. MCP tools

| Tool                        | Credits | Input                                                                                                                                                 | Does                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_local_grid_tracker` | none    | projectId, keywords[1..10], target {placeId?, cid?, name?}, center {latitude, longitude}, gridSize 3 or 5, spacingKm, scheduleInterval monthly/manual | Upserts the project's tracker and replaces its keyword list. Any edit resets the next run to the next 2nd.                                                                                                                                                                                                                                                                                |
| `run_local_grid`            | yes     | projectId, keywords? (subset), force?                                                                                                                 | Runs the due keywords now (all tracker keywords lacking this month's row; all of them with `force`). Description states the cost: 9 calls ≈ $0.018 per keyword on 3×3. Max 75 Maps calls per call (8 keywords on 3×3, 3 on 5×5; 5×5 ≈ 25 calls ≈ $0.05 per keyword). Returns `checked`, `failed`, `alreadyCaptured`, `remaining`, `retry`, `gaveUp`. Refused while a run holds the lease. |
| `get_local_grid`            | none    | projectId                                                                                                                                             | Stored latest + previous per keyword, rendered as text grids with deltas.                                                                                                                                                                                                                                                                                                                 |

## 7. Public summary: `localGrid`

Additive key; consumers that predate it ignore it. Read from D1 only. Absent tracker → `{ "tracked": false, ... "keywords": [] }`. A failed read → `{ "error": "internal_error" }` like every section.

```ts
type LocalGridSection = {
  tracked: boolean; // a tracker exists (active or paused)
  paused: boolean; // tracker paused; stored grids are still returned
  target: {
    name: string | null;
    placeId: string | null;
    cid: string | null;
  } | null;
  center: { latitude: number; longitude: number } | null;
  gridSize: number | null; // 3 or 5
  spacingKm: number | null;
  scheduleInterval: "monthly" | "manual" | null;
  lastCheckedAt: string | null; // ISO
  nextCheckAt: string | null; // ISO
  keywords: LocalGridKeyword[]; // tracker keyword order, then stored-only keywords
};
type LocalGridKeyword = {
  keyword: string;
  period: string; // "YYYY-MM"
  capturedAt: string | null;
  gridSize: number;
  spacingKm: number;
  zoom: number;
  device: "desktop" | "mobile";
  pointsSearched: number;
  pointsFailed: number;
  pointsFound: number;
  top3Count: number;
  top10Count: number;
  solvPct: number | null; // 0..100
  arp: number | null; // 1 decimal place precision kept to 2
  atrp: number | null;
  cells: LocalGridCell[]; // row-major, row 0 = north
  previous: {
    period: string;
    capturedAt: string | null;
    solvPct: number | null;
    arp: number | null;
    atrp: number | null;
    pointsFound: number;
    cells: { row: number; col: number; rank: number | null }[];
  } | null;
  delta: {
    solvPct: number | null;
    arp: number | null;
    atrp: number | null;
    pointsFound: number;
  } | null;
  // latest minus previous; lower arp/atrp is better
};
type LocalGridCell = {
  row: number;
  col: number;
  latitude: number;
  longitude: number;
  rank: number | null; // null = not in the top 20 there
  resultsCount: number | null;
  topCompetitor: {
    title: string | null;
    cid: string | null;
    rank: number;
  } | null;
  error: boolean;
};
```

Example (the live 2026-11-02 run, trimmed to two cells):

```json
{
  "tracked": true,
  "paused": false,
  "target": {
    "name": "Social Booth LV",
    "placeId": "ChIJuy0JGkfryIARL3wzklrIlU0",
    "cid": "5590594803775798319"
  },
  "center": { "latitude": 36.2108236, "longitude": -115.2695665 },
  "gridSize": 3,
  "spacingKm": 2,
  "scheduleInterval": "monthly",
  "lastCheckedAt": "2026-11-03T07:19:36.000Z",
  "nextCheckAt": "2026-12-02T07:00:00.000Z",
  "keywords": [
    {
      "keyword": "brand activation photo booth las vegas",
      "period": "2026-11",
      "capturedAt": "2026-11-03T07:19:36.000Z",
      "gridSize": 3,
      "spacingKm": 2,
      "zoom": 13,
      "device": "mobile",
      "pointsSearched": 9,
      "pointsFailed": 0,
      "pointsFound": 9,
      "top3Count": 9,
      "top10Count": 9,
      "solvPct": 100,
      "arp": 1.56,
      "atrp": 1.56,
      "cells": [
        {
          "row": 0,
          "col": 0,
          "latitude": 36.228911,
          "longitude": -115.2918337,
          "rank": 1,
          "resultsCount": 6,
          "topCompetitor": {
            "title": "BoothNV Photo Booth Rentals",
            "cid": "4471254093198449300",
            "rank": 2
          },
          "error": false
        },
        {
          "row": 0,
          "col": 2,
          "latitude": 36.228911,
          "longitude": -115.2472993,
          "rank": 2,
          "resultsCount": 6,
          "topCompetitor": {
            "title": "Kreate Leverage 360 Photobooth",
            "cid": "1151987186264550461",
            "rank": 1
          },
          "error": false
        }
      ],
      "previous": null,
      "delta": null
    }
  ]
}
```

## 8. UI states (consumer contract)

The admin owns layout (its spec covers 1440 / 1180 / 820 / 390). The API guarantees: `tracked:false` = no tracker; `tracked:true, keywords:[]` = tracker, no run yet; `previous:null` = first month; a cell with `error:true` = search failed there (render as unknown, not "not ranking"); `capturedAt` older than ~45 days = stale (missed a month).

## 9. Tests

- `localRankGrid.test.ts`: points and zoom (existing behaviour), matching by place_id/cid ignores a same-name business, top competitor skips us, SoLV/ARP/ATRP with not-found and failed points.
- `LocalGridService.test.ts` over in-memory SQLite built from the shipped migration (the PAI-217 pattern): run stores snapshot + cells, month idempotency, force replaces cells and accumulates cost, `getLatest` returns previous + delta.
- `scheduledLocalGridChecks.test.ts`: due query, one keyword per tick, lease, next month after the last keyword, retry on failure.
- `localGrid` section test in `PublicSummaryService.test.ts` (shape, untracked, error isolation).
- MCP tool tests for the three tools (cost text, already-captured path).
- Existing `local-seo-tools.test.ts` stays green (the tool's existing fields are unchanged).
- The service and scheduler tests build their tables from the Drizzle schema (`drizzle-kit/api`), not from the numbered migration, so a renumbered migration never breaks them.

## 10. Rollout

1. Merge; deploy self-host (the chained alchemy command in `reference_openseo_setup.md`).
2. Apply the D1 migration `0046_*` (coordinator renumbers if another wave ticket lands first).
3. Create the SBLV tracker (MCP `create_local_grid_tracker`, or D1 insert): keywords _photo booth rental las vegas_, _brand activation photo booth las vegas_, _360 photo booth rental las vegas_; target place_id + CID above; center 36.2108236,-115.2695665; 3×3, 2 km; monthly.
4. Baseline: `run_local_grid` for SBLV (≈ $0.054), or set `next_check_at` to now and let three ticks drain it. **Bryan decision first:** CLIENT-SBLV-188 §5 says run the baseline after the GBP category question is settled, or the baseline mixes two configurations.
5. Check `GET /api/public/v1/projects/c65ed7c9-…/summary` returns `localGrid.keywords[3]`.
