# CLIENT-SBLV-194: public summary v2 (opportunities, audit pages, index status, GA4 key events)

Status: spec + plan, 2026-11-02. Branch `CLIENT-SBLV-194/summary-v2` (from `bb301a5`).
Consumer: SocialBooth admin (`socialboothlv-site`, same ticket id). Any other admin
on the public summary (LodeRx) ignores the new keys.

## Goal

The summary (`GET /api/public/v1/projects/{id}/summary?range=…`, PAI-222) gains four
additive sections built on services that already exist:

| Key | Built on | Source | Cost |
|---|---|---|---|
| `opportunities` | `SearchOpportunityService.getOpportunities` (the `get_search_opportunities` MCP tool) | GSC × GA4, live, cached 6 h in R2 | free |
| `auditPages` | latest completed audit in D1 (`audit_pages`, `audit_issues`, `audit_lighthouse_results`) | D1 | free |
| `indexStatus` | `GscService.inspectUrls` (the `inspect_urls` tool), run by the cron, stored in D1 | D1 only on read | free (GSC quota) |
| `ga4.keyEvents` | `Ga4ReportingService.runReport` kinds `key_events` and `landing_pages` | GA4, live | free |

No DataForSEO call anywhere in this ticket.

## Rules every section follows

- Each section is computed in its own promise and settles on its own. A failure becomes
  `{ "error": "<code>" }` for that key only (same `unwrap`, same codes as today:
  `gsc_quota_exhausted`, `gsc_upstream_unavailable`, `ga4_*`, `internal_error`).
- Each section carries its own `capturedAt` (ISO 8601 UTC): when the data was taken, not
  when the summary was built. `generatedAt` stays the build time.
- Unlinked Google sources return `{ "connected": false }` (as `gsc` / `ga4` do today).
- New keys only. Existing keys and their shapes are unchanged. `ga4.keyEvents` is a new
  key inside the existing `ga4` object; when `ga4` is `{connected:false}` or an error,
  there is no `keyEvents`.
- The summary never calls URL Inspection. It only reads stored rows.
- The handler's 15-minute Workers Cache and its "only cache when the five core sections
  are clean" rule are unchanged (the new sections do not gate caching, like
  `aiVisibility`).

## API contract

TypeScript shapes as returned (JSON). `null` means "no value", never "unknown key".

```ts
type Opportunities =
  | { connected: false }                       // GSC or GA4 not linked
  | {
      connected: true;
      capturedAt: string;                      // when GSC/GA4 were read (cache fill time)
      dateRange: { startDate: string; endDate: string }; // fixed 28 complete days, GA4 property time zone
      businessValueMetric: "sessionKeyEventRate" | "engagementRate";
      totalCandidates: number;                 // GSC pages at positions 4–20
      rows: Array<{                            // best score first, max 25
        page: string;                          // URL as GSC reports it
        score: number | null;                  // 0..100; null when GA4 has no row for the page
        why: string[];                         // reason codes, strongest first (see below)
        clicks: number;
        impressions: number;
        ctr: number;                           // 0..1
        position: number;                      // average GSC position
        sessions: number | null;               // GA4 organic sessions; null when unmatched
        keyEvents: number | null;              // GA4 organic key events; null when unmatched
      }>;
    };

// why codes: "high_demand" (demand component >= 0.66), "converts" (business value >= 0.66),
// "near_page_one" (position <= 10.5, or reachability >= 0.66), "low_ctr" (ctr < 2% with
// >= 100 impressions), "no_analytics" (GSC page with no GA4 landing-page row).

type AuditPages = {
  status: "none" | "running" | "completed" | "failed";  // "none" = no audit yet
  auditId: string | null;
  capturedAt: string | null;                  // completedAt ?? startedAt of that audit
  pagesCrawled: number;
  hasLighthouse: boolean;                     // any Lighthouse row in this audit
  truncated: boolean;                         // more than 250 pages crawled
  pages: Array<{                              // pages with issues first (critical, warning, info), then by URL
    url: string;
    statusCode: number | null;
    issueCounts: { critical: number; warning: number; info: number };
    issues: Array<{
      issueType: string;                      // e.g. "title-too-long"
      severity: "critical" | "warning" | "info";
      details: Record<string, unknown> | null; // parsed details_json, e.g. { "length": 192 }
    }>;
    lighthouse: {
      mobile: LighthouseScores | null;
      desktop: LighthouseScores | null;
    } | null;                                 // null when no strategy has a result
  }>;
};
type LighthouseScores = {
  performance: number | null; accessibility: number | null; bestPractices: number | null; seo: number | null; // 0..100
  lcpMs: number | null; cls: number | null; inpMs: number | null; ttfbMs: number | null;
};

type IndexStatus =
  | { connected: false }
  | {
      connected: true;
      capturedAt: string | null;              // newest inspectedAt; null before the first run
      nextCheckAfter: string | null;          // oldest inspectedAt + 24 h (when the cron may refresh)
      counts: { indexed: number; notIndexed: number; failed: number; pending: number };
      pages: Array<{                          // project key pages, by URL
        url: string;                          // the key page URL (as stored in project context)
        inspectedUrl: string | null;          // the URL actually sent to GSC (rebased on URL-prefix properties)
        state: "indexed" | "not_indexed" | "failed" | "pending";
        verdict: string | null;               // GSC: PASS | PARTIAL | FAIL | NEUTRAL | VERDICT_UNSPECIFIED
        coverageState: string | null;         // e.g. "Submitted and indexed", "Crawled - currently not indexed"
        indexingState: string | null;
        robotsTxtState: string | null;
        pageFetchState: string | null;
        googleCanonical: string | null;
        userCanonical: string | null;
        canonicalMismatch: boolean;           // both canonicals set and different
        lastCrawlTime: string | null;
        crawledAs: string | null;             // DESKTOP | MOBILE
        inspectedAt: string | null;
        error: string | null;                 // per-URL failure text; state "failed"
      }>;
    };

// Added inside the existing ga4 object when ga4.connected is true:
type Ga4KeyEvents =
  | { error: string }
  | {
      capturedAt: string;                     // when GA4 was read
      dateRange: { startDate: string; endDate: string }; // = the summary range
      events: Array<{ eventName: string; keyEvents: number; previousKeyEvents: number | null }>; // organic, most first
      landingPages: Array<{                   // organic landing pages with sessions, most key events first, max 25
        page: string;                         // host + path, e.g. "socialboothlv.com/corporate-events"
        sessions: number;
        keyEvents: number;
        keyEventRate: number;                 // sessionKeyEventRate, 0..1
        events: Array<{ eventName: string; keyEvents: number }>;
      }>;
      tracking: { status: "ok" | "silent" | "no_key_events"; silentEvents: string[] };
      // "silent": an event had key events in the previous period and none now (tracking may be broken)
      // "no_key_events": the property has no key event with a count in either period
    };
```

### Example (trimmed)

```json
{
  "opportunities": {
    "connected": true,
    "capturedAt": "2026-11-02T18:04:11.000Z",
    "dateRange": { "startDate": "2026-10-03", "endDate": "2026-10-30" },
    "businessValueMetric": "sessionKeyEventRate",
    "totalCandidates": 14,
    "rows": [
      { "page": "https://socialboothlv.com/corporate-events", "score": 82, "why": ["high_demand", "near_page_one"],
        "clicks": 9, "impressions": 1840, "ctr": 0.0049, "position": 7.4, "sessions": 21, "keyEvents": 2 }
    ]
  },
  "auditPages": {
    "status": "completed", "auditId": "05f03a0f-…", "capturedAt": "2026-09-05T00:52:05.096Z",
    "pagesCrawled": 100, "hasLighthouse": false, "truncated": false,
    "pages": [
      { "url": "https://socialboothlv.com/services", "statusCode": 200,
        "issueCounts": { "critical": 0, "warning": 0, "info": 2 },
        "issues": [ { "issueType": "meta-description-too-long", "severity": "info", "details": { "length": 192 } } ],
        "lighthouse": null }
    ]
  },
  "indexStatus": {
    "connected": true, "capturedAt": "2026-11-02T10:05:02.000Z", "nextCheckAfter": "2026-11-03T10:00:01.000Z",
    "counts": { "indexed": 17, "notIndexed": 1, "failed": 0, "pending": 1 },
    "pages": [
      { "url": "https://socialboothlv.com/pricing", "inspectedUrl": "https://socialboothlv.com/pricing", "state": "indexed",
        "verdict": "PASS", "coverageState": "Submitted and indexed", "indexingState": "INDEXING_ALLOWED",
        "robotsTxtState": "ALLOWED", "pageFetchState": "SUCCESSFUL",
        "googleCanonical": "https://socialboothlv.com/pricing", "userCanonical": "https://socialboothlv.com/pricing",
        "canonicalMismatch": false, "lastCrawlTime": "2026-10-28T04:11:09Z", "crawledAs": "MOBILE",
        "inspectedAt": "2026-11-02T10:05:02.000Z", "error": null }
    ]
  },
  "ga4": {
    "connected": true, "totals": { "…": "unchanged" },
    "keyEvents": {
      "capturedAt": "2026-11-02T18:04:11.000Z",
      "dateRange": { "startDate": "2026-10-03", "endDate": "2026-10-30" },
      "events": [ { "eventName": "generate_lead", "keyEvents": 5, "previousKeyEvents": 0 } ],
      "landingPages": [ { "page": "socialboothlv.com/corporate-events", "sessions": 21, "keyEvents": 2, "keyEventRate": 0.095,
                          "events": [ { "eventName": "generate_lead", "keyEvents": 2 } ] } ],
      "tracking": { "status": "ok", "silentEvents": [] }
    }
  }
}
```

## Data model and migration

One new table, its own schema file (`src/db/index-status.schema.ts` + `src/db/pg/index-status.schema.ts`),
registered in the three barrels with one line each. Latest result per URL only (no history):
the admin shows "is it indexed now", and the cron overwrites.

```
url_inspections
  id             text pk (uuid)
  project_id     text not null → projects.id on delete cascade
  url            text not null        -- key page URL as stored in project_key_pages
  inspected_url  text not null        -- URL sent to GSC
  verdict, coverage_state, indexing_state, robots_txt_state, page_fetch_state,
  google_canonical, user_canonical, last_crawl_time, crawled_as   text null
  error          text null            -- per-URL failure (state "failed")
  inspected_at   text not null        -- ISO
  unique (project_id, url)
  index  (project_id, inspected_at)
```

Migrations: `drizzle/0046_<name>.sql` and `drizzle-pg/0024_<name>.sql` via `pnpm exec drizzle-kit generate`
(both configs), in their own final commit. The coordinator may renumber on rebase.

## Scheduling (indexStatus)

- Runs inside the existing `scheduled` handler on the `*/5` tick, after the AI-visibility block,
  in its own try/catch. No new cron expression.
- Self-host only (`isHostedServerAuthMode()` → skip).
- Each tick: list projects with a GSC connection; for each, its key pages and stored rows;
  a URL is **due** when it has no row or `inspected_at` is older than 24 h. Take the first
  project (by id) with due URLs and inspect up to **8** of them (Workers Free: 50 subrequests
  per invocation, shared with rank checks and AI visibility). The rest wait for the next tick.
- So every URL is inspected at most once a day. SBLV's 19 key pages finish in 3 ticks;
  all 9 connected projects (~140 key pages) in ~18 ticks (~1.5 h) once a day.
- A per-URL failure is stored with `error` and `inspected_at = now`, so it is retried
  tomorrow, not every 5 minutes. A token/grant failure for the project stores the same
  error on every due URL in that batch.
- URL to inspect: `sc-domain:` property → the key page URL as stored. URL-prefix property
  (`https://www.example.com/`) → the key page's path + query rebased onto the property origin
  (key pages are stored without `www`). A URL outside the property is stored as failed.
- No key pages → nothing inspected; the section returns `pages: []`.

## Opportunities cache

- R2 soft-TTL cache (`getCached` / `setCached`, `r2-cache.ts`), key
  `public-summary:opportunities:<projectId>`, TTL 6 h. Stores the shaped section
  (with `capturedAt`). A miss calls `SearchOpportunityService.getOpportunities({ projectId, limit: 25 })`.
- The window is the service default (28 complete GA4 days ending 3 days ago), independent of
  the summary `range`, because "what to work on next" should not jump with a range pill.
- Unlinked (`ga4_not_connected`, `GscNotConnectedError`, expected grant failure) → `{connected:false}`, not cached.

## Key events

Three GA4 Data API calls in parallel with the rest of the `ga4` section (organic channel,
the summary dates): `key_events` breakdown `event` with `comparePreviousPeriod`,
`key_events` breakdown `event_and_landing_page` (limit 250), `landing_pages` (limit 25).
Merged by normalized `host + path`. Settled separately: a failure is `ga4.keyEvents = {error}`
and leaves the rest of `ga4` intact.

## Cost per month

| Item | Calls | Money |
|---|---|---|
| URL Inspection | ≤ 1 per key page per day (~140/day across 9 projects; quota 2,000/day per property) | $0 |
| Opportunities | ≤ 4 GSC/GA4 calls per project per 6 h, only when the summary is read | $0 |
| Key events | 3 GA4 calls per summary cache miss (15 min Workers Cache, 10 min admin cache) | $0 |
| Audit pages | D1 reads | $0 |
| DataForSEO | none | $0 |

## Test plan

- `sections/opportunities.test.ts`: shaping (score order, why codes, unmatched rows), not-connected
  → `{connected:false}`, cache hit skips the service, cache miss writes.
- `sections/auditPages.test.ts`: real SQL over in-memory SQLite from the shipped audit migrations —
  latest completed audit preferred, issues grouped per page with counts, Lighthouse by strategy,
  no audit → `status:"none"`.
- `sections/indexStatus.test.ts`: state mapping (PASS → indexed, FAIL/NEUTRAL → not_indexed,
  error → failed, no row → pending), canonical mismatch, counts, not connected.
- `scheduledIndexInspections.test.ts`: real due query over in-memory SQLite, only `inspectUrls` mocked —
  due selection (missing / older than 24 h), 8-per-tick cap, failure stored with backoff,
  URL-prefix rebasing, hosted mode skips.
- `sections/ga4KeyEvents.test.ts`: merge by landing page, silent-event detection, no key events.
- `PublicSummaryService.test.ts`: the four keys present; one failing section leaves the others.
- Gate: tsc, `pnpm exec vitest run` (baseline: 1 known failure, `samSkills.test.ts`), oxlint,
  `pnpm exec vite build --mode selfhost`.

## Rollout

1. Coordinator merges (after rebasing onto the other wave branches; renumber the migration if needed).
2. Deploy (chained bash form in `reference_openseo_setup.md`).
3. Apply the D1 migration `0046_…` (`wrangler d1 migrations apply DB --remote` or the CF API).
4. First run: automatic. The next `*/5` tick after deploy starts inspecting; SBLV is complete within
   ~15 minutes, all projects within ~1.5 h. No backfill needed (latest-only table).
5. Verify: `GET …/summary?range=last_28_days` shows `indexStatus.counts.pending` falling to 0, and
   `opportunities`, `auditPages`, `ga4.keyEvents` filled.
6. Rollback: the sections are additive; reverting the Worker leaves an unused table.
