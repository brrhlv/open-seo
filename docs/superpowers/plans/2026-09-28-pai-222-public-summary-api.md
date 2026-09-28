# PAI-222 OpenSEO Public Summary API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `GET https://seo.bryanrivera.ai/api/public/v1/projects/{projectId}/summary?range=last_28_days`: a read-only JSON summary of one project (rankings, backlinks, audit, GSC, GA4). It authenticates with a bearer key bound to one project. A Cloudflare Access service token (path-scoped Access app) fronts it so the SBLV admin v2 Reports page (CLIENT-SBLV-142) can call it server-side.

**Architecture:** This is a raw TanStack Start file route (`server.handlers.GET`), the same pattern as `/api/health`. The route stays thin and delegates to `handlePublicSummaryRequest` in a new `src/server/features/public-api/` feature. That function checks auth itself, bypassing the app's user-JWT middleware: a timing-safe check of the key presented in `Authorization: Bearer` or `X-OpenSEO-Key` against the `OPENSEO_PUBLIC_API_KEYS` secret (`key:projectId[,…]`). It then parses the range and calls `PublicSummaryService.getSummary`, which runs the five sections under `Promise.allSettled`. A failed section becomes `{ "error": "<code>" }`, and an unlinked GSC or GA4 becomes `{ "connected": false }`. Every read reuses existing services and repositories. No DataForSEO-spending path is called. At the edge, a second, path-scoped Access application covers `seo.bryanrivera.ai/api/public` with one `non_identity` policy that admits only the `sblv-admin-openseo` service token. The existing email-gated app keeps covering the rest of the host.

**Tech Stack:** TanStack Start 1.168 (file routes + `server.handlers`) on Cloudflare Workers with D1. Better Auth (Google tokens). Zod 4. Vitest 3 (`pnpm exec vitest run`). pnpm 10.30.1 / Node 25.1. Alchemy 2.0.0-beta.61 (`deploy:selfhost`). Cloudflare API (Access). Vercel CLI 59.20 for the consumer's env vars.

---

## Contract (BINDING, copied from the ticket; the SBLV consumer is being built against exactly this)

`GET https://seo.bryanrivera.ai/api/public/v1/projects/{projectId}/summary?range=last_28_days`
Headers: `Authorization: Bearer <OPENSEO_PUBLIC_API_KEY>` **and/or** `X-OpenSEO-Key: <OPENSEO_PUBLIC_API_KEY>` (the SBLV consumer sends both), plus `CF-Access-Client-Id`, `CF-Access-Client-Secret`.
The server accepts the key from EITHER header. It checks Bearer first, then `X-OpenSEO-Key`, with the same timing-safe compare. If both headers are present and disagree, the request is accepted when either key is valid for the requested project.
The key is bound to one project (secret stored as `key:projectId`). A key that is valid only for other projects returns 404 `{"error":"not_found"}`. No valid key in either header returns 401 `{"error":"unauthorized"}`. A range outside `last_7_days | last_28_days | last_90_days` returns 422 (`{"error":"invalid_range"}`). The default range is `last_28_days`. Every response carries `Cache-Control: private, max-age=0`.

```json
{ "project": {"id": "…", "domain": "socialboothlv.com"}, "generatedAt": "ISO",
  "range": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"},
  "rankings": {"trackedKeywords": 0, "top10": 0, "improved": 0, "declined": 0, "lastCheckedAt": "ISO|null",
    "keywords": [{"keyword": "", "device": "mobile", "position": 0, "previousPosition": 0, "url": ""}]},
  "backlinks": {"backlinks": 0, "referringDomains": 0, "rank": 0, "capturedAt": "ISO|null"},
  "audit": {"status": "", "pagesCrawled": 0, "startedAt": "ISO|null", "issuesBySeverity": {"critical": 0, "warning": 0, "info": 0}},
  "gsc": {"connected": true, "totals": {"clicks": 0, "impressions": 0, "ctr": 0, "position": 0},
    "prevTotals": {"clicks": 0, "impressions": 0, "ctr": 0, "position": 0},
    "daily": [{"date": "YYYY-MM-DD", "clicks": 0, "impressions": 0}],
    "topQueries": [{"query": "", "clicks": 0, "impressions": 0, "ctr": 0, "position": 0}]},
  "ga4": {"connected": true, "totals": {"sessions": 0, "activeUsers": 0, "engagementRate": 0, "keyEvents": 0},
    "prevTotals": {"sessions": 0, "activeUsers": 0, "engagementRate": 0, "keyEvents": 0},
    "daily": [{"date": "YYYY-MM-DD", "sessions": 0}],
    "sources": [{"source": "", "medium": "", "sessions": 0}]} }
```

**Semantics this plan pins down.** The contract does not specify these. Relay them to CLIENT-SBLV-142 in the final task.

- `range` covers N inclusive days ending 3 days before today (UTC), the GSC data lag. GSC and GA4 both use this same window, and each compares against the equal-length period just before it.
- `rankings`:
  - Movement is compared over `7d` / `30d` / `90d` for `last_7_days` / `last_28_days` / `last_90_days`.
  - `keywords` holds one entry per keyword×device that has a current or previous position. It is sorted best position first, with `null` last, and capped at 100.
  - `position` / `previousPosition` / `url` may be `null` (the keyword is not ranking, or there is no earlier snapshot).
  - With no tracking config, all counts are 0 and `keywords` is `[]`.
- `backlinks` reads the latest stored snapshot only. With no snapshot, the counts are 0 and `capturedAt` is `null`.
- `audit`:
  - `status` is `running | completed | failed`, or `none` when no audit has ever run.
  - `issuesBySeverity[s]` is the sum of affected pages over every issue type of severity `s`.
- `gsc.topQueries` is the top 10 queries in GSC order (clicks desc). A dead or denied Google grant is reported as `connected:false`, as the in-app page does.
- `ga4`:
  - `totals`, `prevTotals` and `daily` are **Organic Search only** (`Ga4OrganicOverviewService`).
  - `sources` covers **all channels**: the top 10 `sessionSourceMedium` by sessions, split on `" / "`.
- Section error codes: GA4 errors pass through their `Ga4ReportError.code` (e.g. `ga4_quota_exhausted`, `ga4_reconnect_required`). GSC API errors become `gsc_quota_exhausted` (429) or `gsc_upstream_unavailable`. Anything else becomes `internal_error`.
- All timestamps are ISO-8601 UTC. SQLite `YYYY-MM-DD HH:MM:SS` values are normalized.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/server/lib/timingSafeEqual.ts` | create | Constant-time string compare (moved verbatim from `src/server/gdpr/storage-erasure.ts:30-39`) |
| `src/server/gdpr/storage-erasure.ts` | modify | Import `timingSafeEqual` instead of its private copy |
| `src/server/lib/gscErrors.ts` | modify | Gains `isExpectedGrantFailure` (moved from `GscService.ts:84-90`) so tests can import it without the heavy service |
| `src/server/features/gsc/services/GscService.ts` | modify | Re-export `isExpectedGrantFailure` from the leaf; drop the local copy and the now-unused `GscApiError` import |
| `src/server/features/rank-tracking/services/rankSummary.ts` | create | Pure `summarizeRankResults` + `RankSummary` type (extracted from `DashboardService.ts:122-164`) |
| `src/server/features/dashboard/services/DashboardService.ts` | modify | Use `summarizeRankResults`; expose `getBacklinkSummary` on the `DashboardService` object |
| `src/server/features/public-api/publicApiAuth.ts` (+ `.test.ts`) | create | Parse `OPENSEO_PUBLIC_API_KEYS`; `resolvePresentedKeys(headers)` (Bearer, then `X-OpenSEO-Key`); `resolveBoundProjects` (timing-safe, every presented key × every configured key) |
| `src/server/features/public-api/publicSummaryRange.ts` (+ `.test.ts`) | create | Range enum parse (default/422), window dates, rank compare period |
| `src/server/features/public-api/PublicSummaryService.ts` (+ `.test.ts`) | create | Section assembler with `Promise.allSettled` |
| `src/server/features/public-api/publicSummaryHandler.ts` (+ `.test.ts`) | create | HTTP semantics: 401/404/422/500/200 + `Cache-Control` |
| `src/routes/api/public/v1/projects/$projectId/summary.ts` | create | Thin raw file route; 404 in hosted mode |
| `src/routeTree.gen.ts` | regenerated | By `vite build`; commit the regenerated file |
| `src/env.d.ts` | modify | `OPENSEO_PUBLIC_API_KEYS?: string` |
| `alchemy.run.ts` | modify | `OPENSEO_PUBLIC_API_KEYS: optionalSecret(...)` in `dataEnv` |
| `.env.selfhost.example` | modify | Document the new optional secret |

Do **not** touch the review control plane: `.greptile/**`, `AGENTS.md`, `CLAUDE.md`, `.agents/skills/**`, `.github/**` (repo `CLAUDE.md:37`, `.github/CODEOWNERS`). Nothing in this plan needs them. If a papercut comes up, append it to `.agents/PAPERCUTS.md` with the `papercuts` skill (`CLAUDE.md:27-31`). That file is not control plane.

---

## Facts the implementer must not rediscover

**Repo / git**
- Main checkout: `C:\Users\Brizzle\projects\tools\_active\open-seo` (branch `main`, 2 commits ahead of `origin/main`: `9dbaa54` SELFHOST_DOMAINS, `43e9ae3` papercut; the tree is clean). Remote `origin` = `https://github.com/brrhlv/open-seo.git`.
- The worktree **already exists** (created while planning): `C:\Users\Brizzle\projects\tools\_active\open-seo-PAI-222` on branch `PAI-222/public-summary-api` from `main@43e9ae3`. It has **no** `node_modules` and **no** `.env.selfhost`, both of which are gitignored (`.gitignore:17`, `.gitignore:46` for `.alchemy/`).
- Tooling: Node v25.1.0, pnpm 10.30.1. `.npmrc` sets `node-options=--max-old-space-size=4096`.
- Shell: Git Bash. Every Bash call starts fresh, so no variables carry over between calls. Each command block below is self-contained.

**Routing / auth**
- The raw route template is `src/routes/api/health.ts:24-30` (`createFileRoute(path)({ server: { handlers: { GET } } })`). Handlers receive `{ request, params }`. `src/routes/api/auth/$.ts` is a second example.
- Worker entry `src/server.ts`:
  - `handleFetch` (`:140-179`) dispatches `/agents/*` (`:155`) and, in self-host modes, `/mcp` (`:172-176`). Everything else goes to `appFetch(request)` (`:178`), so `/api/public/*` reaches the TanStack route with no global auth.
  - `src/start.ts` only adds CSRF middleware, and only for `serverFn` handlers.
- `src/middleware/ensure-user/cloudflareAccess.ts:91-94` requires an `email` claim. Service-token JWTs have none, so the new route must never go through `ensureUser` or `requireProjectContext`. `.greptile/rules.md:37`: "Raw API routes … establish and translate their own trust boundary explicitly." `.greptile/rules.md:67`: auth changes and secret-bearing requests "require a manual security read of the changed path" (Task 8).
- Self-host has no usable API-key mechanism: the Better Auth apiKey plugin exists only in `AUTH_MODE=hosted`.
- A timing-safe compare already exists at `src/server/gdpr/storage-erasure.ts:30-39`. Task 2 moves it to a leaf so both callers share it.

**Data reuse (all read-only; D1 or first-party Google)**
- `DashboardService.getOverview` (`DashboardService.ts:110-120`) is **not** reused as a whole. It uses `Promise.all`, so one failing section fails all three, and its audit summary keeps only the top 3 issue types. Reuse its parts instead:
  - `RankTrackingRepository.getConfigsForProject` (`RankTrackingRepository.ts:37`) + `getLatestResults(configId, projectId, comparePeriod)` (`rankTrackingResults.ts:21`). Rows are `RankTrackingRow` with `desktop`/`mobile: { position, previousPosition, rankingUrl }` (`src/types/schemas/rank-tracking.ts:29-44`). Cap at 5 configs, the same as `MAX_CONFIGS_FOR_OVERVIEW` (`DashboardService.ts:23`).
  - `DashboardService.getBacklinkSummary(projectId, domain)` (`:200-220`) reads the latest stored snapshot only.
  - `AuditRepository.getLatestAuditForProject` (`AuditRepository.ts:269`) + `getIssueTypePageCountsForAudit(auditId)` (`auditSummaryQueries.ts:11`) returns `{ issueType, severity, pages }`.
- **Never** call `DashboardService.ensureBacklinkSnapshot` (`:232`; spends DataForSEO credits), AI visibility, or any opportunity/SERP service.
- `ProjectService.getProjectWithOrganization(projectId)` (`projects.ts:251`) returns `{ organizationId, project: { id, domain, … } } | null`. It excludes archived projects.
- GSC: `GscService.getPerformance({ projectId, startDate, endDate, dimensions, rowLimit })` (`GscService.ts:226-248`). It throws `GscNotConnectedError` when the project is unlinked. Tokens are minted headerless for `connection.connectedByUserId` (`src/server/lib/gscClient.ts:90-97`), so no user session is needed.
- The GSC composition to mirror is `src/serverFunctions/searchPerformance.ts:65-131`, with helpers `sumSearchTotals`, `toDimensionRows` and `previousPeriod` in `src/server/features/gsc/searchPerformanceReport.ts:41,61,127`. "Expected connection failure" = `GscNotConnectedError || isExpectedGrantFailure` (`searchPerformance.ts:54-56`).
- `GSC_DATE_RANGES` (`searchAnalytics.ts:26-33`) has no `last_90_days`, and `resolveDateRange` lags 3 days (`:41`). That is why this plan passes explicit `startDate`/`endDate`.
- GA4:
  - `Ga4OrganicOverviewService.getOrganicOverview({ projectId, startDate, endDate, trend: "daily" })` (`Ga4OrganicOverviewService.ts:65-155`) returns `current`/`previous` rows keyed by metric name and `trend` rows with `date` as **`YYYYMMDD`**. It is Organic Search only (`Ga4ReportDefinitions.ts:109-116`, `:278-296`).
  - `Ga4ReportingService.runReport({ projectId, kind: "traffic_acquisition", acquisitionBreakdown: "source_medium", channel: "all", startDate, endDate, limit })` (`Ga4ReportingService.ts:240-368`) returns rows `{ sessionSourceMedium: "google / organic", sessions, … }`. Its **default channel is `organic_search`** (`:252`), so pass `"all"`.
  - Both throw `Ga4ReportError` (`src/server/lib/ga4Errors.ts:50-59`, a leaf module) with `code: "ga4_not_connected"` when unlinked.
- Timestamps: SQLite defaults store `YYYY-MM-DD HH:MM:SS` in UTC, and Postgres and app writes store ISO (`.greptile/rules.md:90`). Normalize to ISO at the wire.

**Tests** (repo `CLAUDE.md:15-25`)
- Import the module under test statically.
- Mock collaborators with `vi.hoisted` + `vi.mock(path, factory)`; `Ga4OrganicOverviewService.test.ts:1-17` is the template.
- `beforeEach` sets default return values only; `clearMocks` and `restoreMocks` are on (`vitest.config.ts`).
- Fixtures carry only the asserted fields. Never re-declare a production class; import it from a leaf.
- Run one file with `pnpm exec vitest run <path>`.

**Cloudflare (read live via the API on 2026-09-28)**
- `.env.selfhost` (main checkout only) defines `DATAFORSEO_API_KEY, ACCESS_ALLOWED_EMAILS, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BETTER_AUTH_SECRET, SELFHOST_DOMAINS, OPENSEO_TELEMETRY_DISABLED, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID`. `TEAM_DOMAIN`/`POLICY_AUD` are unset, so **alchemy re-provisions the email Access app on every deploy** (`alchemy.run.ts` `resolveSelfHostAccess`, `emailAccessGate` in `alchemy.access.ts:61-81`, which only sets `domain` = the workers.dev host).
- Access apps:
  - `0f0045d6-c514-4f7e-8beb-272de8318848` "open-seo selfhost". The id is shown for orientation only; the scripts look the app up by name/domain. Its destinations are `open-seo-selfhost.bryan-rivera-bfd.workers.dev` **and `seo.bryanrivera.ai`**; the second was added by hand (`.env.selfhost.example` says "Add the same hostname(s) to your Access application if you manage it yourself"). Its policy is "open-seo selfhost self-host users" (allow).
  - Team domain is `dark-sea-f641.cloudflareaccess.com`.
  - The path-scoped precedent is "Twenty CRM API" (`crm.bryanrivera.ai/rest`). There are **no service tokens yet**, and no reusable policy other than the email one.
- The worker custom domain `seo.bryanrivera.ai` maps to service `open-seo-selfhost` (production).
- Access edge behavior today:
  - A non-browser request without credentials gets **HTTP 401 `application/json` `{"error":"invalid_token",…}`** with `WWW-Authenticate: Bearer realm="OAuth"`.
  - A browser request (`Accept: text/html`) gets **302** to `https://dark-sea-f641.cloudflareaccess.com/cdn-cgi/access/login/…`.
  - Our worker's 401 is `{"error":"unauthorized"}`. Tell the two apart by the `error` value.

**Deploy on Windows** (commit `43e9ae3`, `.agents/PAPERCUTS.md`)
- `pnpm deploy:selfhost` passes preflight, build and typecheck, then dies at the `alchemy` script with `'NODE_OPTIONS' is not recognized`: `package.json` `"alchemy": "NODE_OPTIONS=\"$NODE_OPTIONS --experimental-strip-types\" alchemy"` runs under cmd.exe. The working path is to run the same four steps by hand in **Git Bash** from the **main checkout** (which has `.env.selfhost`, `node_modules`, `.alchemy/`). Alchemy state is in the Cloudflare state store (`alchemy.run.ts:302-305`). Details are in Task 9.
- There is no DB schema change, so no migrations.

**Consumer (SBLV)**
- Repo: `C:\Users\Brizzle\projects\clients\socialbooth-lv\socialboothlv-site` (Vercel-linked, project `socialboothlv-site`).
- Vercel CLI 59.20.0: `vercel env add <name> <env> --sensitive --yes` reads the value from stdin. `--yes` on `preview` means all branches.
- Env names: `OPENSEO_API_KEY`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` (Sensitive); `OPENSEO_API_URL=https://seo.bryanrivera.ai`, `OPENSEO_PROJECT_ID=c65ed7c9-ee05-4b6d-a61f-8817c7a003ae`.

**Secret hygiene:** never `echo`/`cat`/`set -x` a key, client secret or `.env.selfhost`. Every command below keeps values in shell variables or in files under the working dir `D="$HOME/.pai222"`, which Task 12 deletes.

**One working dir for bash and python (do not use `/tmp`).** Git Bash `/tmp` is `%LOCALAPPDATA%\Temp`, but the native Windows python (`/c/Python312`) resolves `/tmp` to `C:\tmp`, so the two tools would read and write different files. Every block below therefore:
- uses `D="$HOME/.pai222"; mkdir -p "$D"`;
- lets **bash** do all file reads and writes (`curl -o`, `>` redirects, `< file` into python's stdin);
- hands python a path only as a Windows path via an env var (`SNAP_W="$(cygpath -w "$D/…")"`, read with `os.environ[...]`).

`umask` does **not** protect files on NTFS, so `$D` is not a secure store. The Access client secret sits there only between Task 10 and Task 12, which deletes it. The email-app snapshot (`$D/email-app.snapshot.json`, no secrets) is kept for Rollback until Task 14.

---

### Task 1: Worktree baseline

**Files:** none (environment only)

- [ ] **Step 1: Confirm the worktree and install deps**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && git status -sb && git log --oneline -1 && pnpm install --frozen-lockfile
```
Expected: `## PAI-222/public-summary-api`, HEAD `43e9ae3`, install completes.

- [ ] **Step 2: Baseline test run**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec vitest run src/server/features/gsc src/server/features/ga4 src/server/features/rank-tracking
```
Expected: PASS. If something fails before any change, stop and report it; do not fix unrelated tests.

---

### Task 2: Move shared helpers to leaf modules (refactor under green)

**Files:**
- Create: `src/server/lib/timingSafeEqual.ts`
- Modify: `src/server/gdpr/storage-erasure.ts:30-39` (delete the local fn, add the import)
- Modify: `src/server/lib/gscErrors.ts` (append `isExpectedGrantFailure`)
- Modify: `src/server/features/gsc/services/GscService.ts:11-16,84-90`
- Create: `src/server/features/rank-tracking/services/rankSummary.ts`
- Modify: `src/server/features/dashboard/services/DashboardService.ts:41-47,75-79,122-164,297-301`

These are behavior-preserving moves, and the existing suites guard them. No new tests: `summarizeRankResults` is covered through `PublicSummaryService` in Task 5.

- [ ] **Step 1: Create `src/server/lib/timingSafeEqual.ts`**

```ts
/** Constant-time string comparison: the loop always runs max(len) times and
 *  the length difference is folded into the result, so neither content nor
 *  prefix length leaks through timing. */
export function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
```

- [ ] **Step 2: Use it in `storage-erasure.ts`.** Delete the `function timingSafeEqual(...) {...}` block (lines 30-39) and add, next to the other `@/server/lib/*` imports:

```ts
import { timingSafeEqual } from "@/server/lib/timingSafeEqual";
```

- [ ] **Step 3: Move `isExpectedGrantFailure` into `src/server/lib/gscErrors.ts`.** Append at the end of the file:

```ts
/** A dead or denied Google grant (token failure, or GSC 401/403): the caller
 *  shows "not connected" rather than an error. Other statuses are real faults. */
export function isExpectedGrantFailure(error: unknown): boolean {
  if (error instanceof GscTokenError) return true;
  return (
    error instanceof GscApiError &&
    (error.status === 401 || error.status === 403)
  );
}
```

- [ ] **Step 4: Update `GscService.ts`.** Delete the function at lines 84-90. Change the import block at lines 11-16 to:

```ts
import {
  GscNotConnectedError,
  GscTokenError,
  isExpectedGrantFailure,
} from "@/server/lib/gscErrors";
export {
  GscNotConnectedError,
  isExpectedGrantFailure,
} from "@/server/lib/gscErrors";
```

`GscApiError` is no longer referenced in `GscService.ts`; confirm with `grep -n GscApiError src/server/features/gsc/services/GscService.ts`, which should print nothing. `GscTokenError` is still used at `:290`. `src/serverFunctions/searchPerformance.ts:5` keeps importing `isExpectedGrantFailure` from `GscService` through the re-export, so it needs no change.

- [ ] **Step 5: Create `src/server/features/rank-tracking/services/rankSummary.ts`**

```ts
import type { RankTrackingRow } from "@/types/schemas/rank-tracking";

export type RankSummary = {
  trackedKeywords: number;
  improved: number;
  declined: number;
  top10: number;
  lastCheckedAt: string | null;
};

type RankResults = {
  rows: RankTrackingRow[];
  run: { lastCheckedAt: string | null } | null;
};

/** Roll the latest rank-check results (one entry per tracking config) into
 *  headline counts. Lower position number = better ranking. */
export function summarizeRankResults(results: RankResults[]): RankSummary {
  const summary: RankSummary = {
    trackedKeywords: 0,
    improved: 0,
    declined: 0,
    top10: 0,
    lastCheckedAt: null,
  };

  for (const result of results) {
    summary.trackedKeywords += result.rows.length;
    if (
      result.run?.lastCheckedAt &&
      (!summary.lastCheckedAt ||
        result.run.lastCheckedAt > summary.lastCheckedAt)
    ) {
      summary.lastCheckedAt = result.run.lastCheckedAt;
    }
    for (const row of result.rows) {
      for (const device of ["desktop", "mobile"] as const) {
        const { position, previousPosition } = row[device];
        if (position !== null && position <= 10) summary.top10 += 1;
        if (position === null || previousPosition === null) continue;
        if (position < previousPosition) summary.improved += 1;
        else if (position > previousPosition) summary.declined += 1;
      }
    }
  }

  return summary;
}
```

- [ ] **Step 6: Update `DashboardService.ts`**
  - Delete `type DashboardRankSummary = {...}` (lines 41-47).
  - Add `import { summarizeRankResults, type RankSummary } from "@/server/features/rank-tracking/services/rankSummary";`.
  - In `type DashboardOverview`, change `rank: DashboardRankSummary | null;` to `rank: RankSummary | null;`.
  - Replace `getRankSummary` (lines 122-164) with:

```ts
async function getRankSummary(projectId: string): Promise<RankSummary | null> {
  const configs = await RankTrackingRepository.getConfigsForProject(projectId);
  if (configs.length === 0) return null;

  const results = await Promise.all(
    configs
      .slice(0, MAX_CONFIGS_FOR_OVERVIEW)
      .map((config) => getLatestResults(config.id, projectId, "7d")),
  );
  return summarizeRankResults(results);
}
```

  - Change the export object (lines 297-301) to:

```ts
export const DashboardService = {
  getActivation,
  getOverview,
  getBacklinkSummary,
  ensureBacklinkSnapshot,
};
```

- [ ] **Step 7: Run the guards**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec tsc --noEmit && pnpm exec vitest run src/server/features/gsc src/server/features/rank-tracking src/server/features/ga4 && pnpm exec oxlint src/server/lib src/server/gdpr src/server/features/gsc src/server/features/dashboard src/server/features/rank-tracking --type-aware
```
Expected: tsc clean, tests PASS, no lint errors.

- [ ] **Step 8: Commit**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec prettier --write src/server/lib/timingSafeEqual.ts src/server/gdpr/storage-erasure.ts src/server/lib/gscErrors.ts src/server/features/gsc/services/GscService.ts src/server/features/rank-tracking/services/rankSummary.ts src/server/features/dashboard/services/DashboardService.ts && git add src/server/lib/timingSafeEqual.ts src/server/gdpr/storage-erasure.ts src/server/lib/gscErrors.ts src/server/features/gsc/services/GscService.ts src/server/features/rank-tracking/services/rankSummary.ts src/server/features/dashboard/services/DashboardService.ts && git commit -m "$(cat <<'EOF'
refactor: move timingSafeEqual, isExpectedGrantFailure, rank summary to leaf modules (PAI-222)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Key parsing and key → project binding (Bearer or X-OpenSEO-Key)

**Files:**
- Create: `src/server/features/public-api/publicApiAuth.test.ts`
- Create: `src/server/features/public-api/publicApiAuth.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  parsePublicApiKeys,
  resolveBoundProjects,
  resolvePresentedKeys,
} from "./publicApiAuth";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("parsePublicApiKeys", () => {
  it("parses key:projectId pairs and drops malformed, short, or unbound entries", () => {
    expect(
      parsePublicApiKeys(
        ` ${KEY_A}:proj-a , ${KEY_B}:proj-b,,nocolon,short:proj-c,${"c".repeat(64)}:`,
      ),
    ).toEqual([
      { key: KEY_A, projectId: "proj-a" },
      { key: KEY_B, projectId: "proj-b" },
    ]);
    expect(parsePublicApiKeys(undefined)).toEqual([]);
  });
});

describe("resolvePresentedKeys", () => {
  it("reads Bearer first, then X-OpenSEO-Key, ignoring other schemes and blanks", () => {
    expect(
      resolvePresentedKeys(
        new Headers({ authorization: `Bearer ${KEY_A}`, "x-openseo-key": KEY_B }),
      ),
    ).toEqual([KEY_A, KEY_B]);
    expect(
      resolvePresentedKeys(
        new Headers({ authorization: `Basic ${KEY_A}`, "x-openseo-key": " " }),
      ),
    ).toEqual([]);
  });
});

describe("resolveBoundProjects", () => {
  const keys = parsePublicApiKeys(`${KEY_A}:proj-a,${KEY_B}:proj-b`);
  const bound = (headers: Record<string, string>) => [
    ...resolveBoundProjects(new Headers(headers), keys),
  ];

  it("binds a Bearer key or an X-OpenSEO-Key key to its project", () => {
    expect(bound({ authorization: `Bearer ${KEY_B}` })).toEqual(["proj-b"]);
    expect(bound({ "x-openseo-key": KEY_A })).toEqual(["proj-a"]);
  });

  it("accepts either key when both headers are present and disagree", () => {
    expect(
      bound({ authorization: "Bearer wrong", "x-openseo-key": KEY_A }),
    ).toEqual(["proj-a"]);
    expect(
      bound({ authorization: `Bearer ${KEY_A}`, "x-openseo-key": "wrong" }),
    ).toEqual(["proj-a"]);
  });

  it.each([
    {},
    { authorization: KEY_A },
    { authorization: `Basic ${KEY_A}` },
    { authorization: `Bearer ${KEY_A.slice(1)}` },
    { authorization: `Bearer ${KEY_A}x` },
    { "x-openseo-key": `${KEY_A}x` },
  ])("rejects %j", (headers) => {
    expect(bound(headers)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec vitest run src/server/features/public-api/publicApiAuth.test.ts
```
Expected: FAIL with `Failed to resolve import "./publicApiAuth"` (or `Cannot find module`).

- [ ] **Step 3: Implement `publicApiAuth.ts`**

```ts
import { timingSafeEqual } from "@/server/lib/timingSafeEqual";

type PublicApiKey = { key: string; projectId: string };

// Keys are generated with `openssl rand -hex 32` (64 chars); refuse anything
// short enough to be guessable so a typo'd secret fails closed.
const MIN_KEY_LENGTH = 32;

/** OPENSEO_PUBLIC_API_KEYS = "key:projectId[,key:projectId]". Entries missing
 *  either half, or with a short key, are ignored. */
export function parsePublicApiKeys(raw: string | undefined): PublicApiKey[] {
  if (!raw) return [];
  const keys: PublicApiKey[] = [];
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf(":");
    if (separator < 0) continue;
    const key = entry.slice(0, separator).trim();
    const projectId = entry.slice(separator + 1).trim();
    if (key.length < MIN_KEY_LENGTH || !projectId) continue;
    keys.push({ key, projectId });
  }
  return keys;
}

/** Keys presented on the request, in order: `Authorization: Bearer <key>`,
 *  then `X-OpenSEO-Key: <key>`. The consumer sends both (PAI-222 contract). */
export function resolvePresentedKeys(headers: Headers): string[] {
  const presented: string[] = [];
  const bearer = /^Bearer\s+(\S+)$/i.exec(
    headers.get("authorization")?.trim() ?? "",
  )?.[1];
  if (bearer) presented.push(bearer);
  const headerKey = headers.get("x-openseo-key")?.trim();
  if (headerKey) presented.push(headerKey);
  return presented;
}

/** Projects bound to ANY presented key (so disagreeing headers are accepted
 *  when either one is valid). Every presented key is compared against every
 *  configured key in constant time, with no early exit. */
export function resolveBoundProjects(
  headers: Headers,
  keys: PublicApiKey[],
): Set<string> {
  const projects = new Set<string>();
  for (const presented of resolvePresentedKeys(headers)) {
    for (const entry of keys) {
      if (timingSafeEqual(presented, entry.key)) projects.add(entry.projectId);
    }
  }
  return projects;
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec vitest run src/server/features/public-api/publicApiAuth.test.ts
```
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec prettier --write src/server/features/public-api/publicApiAuth.ts src/server/features/public-api/publicApiAuth.test.ts && git add src/server/features/public-api/publicApiAuth.ts src/server/features/public-api/publicApiAuth.test.ts && git commit -m "$(cat <<'EOF'
feat(public-api): parse project-bound API keys; accept Bearer or X-OpenSEO-Key (PAI-222)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Range parsing and window dates

**Files:**
- Create: `src/server/features/public-api/publicSummaryRange.test.ts`
- Create: `src/server/features/public-api/publicSummaryRange.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  parsePublicSummaryRange,
  resolvePublicSummaryDates,
} from "./publicSummaryRange";

const NOW = new Date("2026-09-28T12:00:00Z");

describe("parsePublicSummaryRange", () => {
  it("defaults to last_28_days when absent and rejects unsupported values", () => {
    expect(parsePublicSummaryRange(null)).toBe("last_28_days");
    expect(parsePublicSummaryRange("last_90_days")).toBe("last_90_days");
    expect(parsePublicSummaryRange("last_3_months")).toBeNull();
    expect(parsePublicSummaryRange("")).toBeNull();
  });
});

describe("resolvePublicSummaryDates", () => {
  it.each([
    ["last_7_days", "2026-09-19"],
    ["last_28_days", "2026-08-29"],
    ["last_90_days", "2026-06-28"],
  ] as const)("%s covers N inclusive days ending 3 days ago", (range, start) => {
    expect(resolvePublicSummaryDates(range, NOW)).toEqual({
      start,
      end: "2026-09-25",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec vitest run src/server/features/public-api/publicSummaryRange.test.ts
```
Expected: FAIL with `Failed to resolve import "./publicSummaryRange"`.

- [ ] **Step 3: Implement `publicSummaryRange.ts`**

```ts
import { z } from "zod";
import type { ComparePeriod } from "@/types/schemas/rank-tracking";

const publicSummaryRangeSchema = z.enum([
  "last_7_days",
  "last_28_days",
  "last_90_days",
]);
export type PublicSummaryRange = z.infer<typeof publicSummaryRangeSchema>;

const RANGE_DAYS: Record<PublicSummaryRange, number> = {
  last_7_days: 7,
  last_28_days: 28,
  last_90_days: 90,
};

/** Rank movement compares against the snapshot nearest the window start. */
export const RANK_COMPARE_PERIOD: Record<PublicSummaryRange, ComparePeriod> = {
  last_7_days: "7d",
  last_28_days: "30d",
  last_90_days: "90d",
};

// GSC data trails ~2-3 days (searchAnalytics.ts GSC_DATA_LAG_DAYS). Ending the
// GSC and GA4 windows on the same lagged day keeps both sources on identical
// dates in one response.
const DATA_LAG_DAYS = 3;

/** Absent (`null`) → the default; anything unsupported → null (HTTP 422). */
export function parsePublicSummaryRange(
  raw: string | null,
): PublicSummaryRange | null {
  const parsed = publicSummaryRangeSchema.safeParse(raw ?? "last_28_days");
  return parsed.success ? parsed.data : null;
}

/** N inclusive UTC days ending DATA_LAG_DAYS before `now`. */
export function resolvePublicSummaryDates(
  range: PublicSummaryRange,
  now: Date = new Date(),
): { start: string; end: string } {
  const end = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - DATA_LAG_DAYS,
    ),
  );
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (RANGE_DAYS[range] - 1));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec vitest run src/server/features/public-api/publicSummaryRange.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec prettier --write src/server/features/public-api/publicSummaryRange.ts src/server/features/public-api/publicSummaryRange.test.ts && git add src/server/features/public-api/publicSummaryRange.ts src/server/features/public-api/publicSummaryRange.test.ts && git commit -m "$(cat <<'EOF'
feat(public-api): summary range parsing and shared GSC/GA4 window (PAI-222)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Section assembler (`PublicSummaryService`)

**Files:**
- Create: `src/server/features/public-api/PublicSummaryService.test.ts`
- Create: `src/server/features/public-api/PublicSummaryService.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ga4ReportError } from "@/server/lib/ga4Errors";
import { GscApiError, GscNotConnectedError } from "@/server/lib/gscErrors";
import { PublicSummaryService } from "./PublicSummaryService";

const mocks = vi.hoisted(() => ({
  getProjectWithOrganization: vi.fn(),
  getConfigsForProject: vi.fn(),
  getLatestResults: vi.fn(),
  getBacklinkSummary: vi.fn(),
  getLatestAuditForProject: vi.fn(),
  getIssueTypePageCountsForAudit: vi.fn(),
  getPerformance: vi.fn(),
  getOrganicOverview: vi.fn(),
  runReport: vi.fn(),
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectWithOrganization: mocks.getProjectWithOrganization,
  },
}));
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getConfigsForProject: mocks.getConfigsForProject,
    },
  }),
);
vi.mock("@/server/features/rank-tracking/services/rankTrackingResults", () => ({
  getLatestResults: mocks.getLatestResults,
}));
vi.mock("@/server/features/dashboard/services/DashboardService", () => ({
  DashboardService: { getBacklinkSummary: mocks.getBacklinkSummary },
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    getLatestAuditForProject: mocks.getLatestAuditForProject,
  },
}));
vi.mock("@/server/features/audit/repositories/auditSummaryQueries", () => ({
  getIssueTypePageCountsForAudit: mocks.getIssueTypePageCountsForAudit,
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance: mocks.getPerformance },
}));
vi.mock("@/server/features/ga4/services/Ga4OrganicOverviewService", () => ({
  Ga4OrganicOverviewService: {
    getOrganicOverview: mocks.getOrganicOverview,
  },
}));
vi.mock("@/server/features/ga4/services/Ga4ReportingService", () => ({
  Ga4ReportingService: { runReport: mocks.runReport },
}));

const NOW = new Date("2026-09-28T12:00:00Z");
const input = { projectId: "proj-a", range: "last_28_days", now: NOW } as const;

describe("PublicSummaryService.getSummary", () => {
  beforeEach(() => {
    mocks.getProjectWithOrganization.mockResolvedValue({
      organizationId: "org-1",
      project: { id: "proj-a", domain: "socialboothlv.com" },
    });
    mocks.getConfigsForProject.mockResolvedValue([]);
    mocks.getBacklinkSummary.mockResolvedValue(null);
    mocks.getLatestAuditForProject.mockResolvedValue(undefined);
    mocks.getPerformance.mockRejectedValue(new GscNotConnectedError("proj-a"));
    mocks.getOrganicOverview.mockRejectedValue(
      new Ga4ReportError("ga4_not_connected", "not connected"),
    );
    mocks.runReport.mockRejectedValue(
      new Ga4ReportError("ga4_not_connected", "not connected"),
    );
  });

  it("returns null for an unknown or archived project", async () => {
    mocks.getProjectWithOrganization.mockResolvedValue(null);
    expect(await PublicSummaryService.getSummary(input)).toBeNull();
  });

  it("reports unlinked GSC/GA4 as connected:false and empty D1 sections as zeros", async () => {
    expect(await PublicSummaryService.getSummary(input)).toEqual({
      project: { id: "proj-a", domain: "socialboothlv.com" },
      generatedAt: "2026-09-28T12:00:00.000Z",
      range: { start: "2026-08-29", end: "2026-09-25" },
      rankings: {
        trackedKeywords: 0,
        top10: 0,
        improved: 0,
        declined: 0,
        lastCheckedAt: null,
        keywords: [],
      },
      backlinks: {
        backlinks: 0,
        referringDomains: 0,
        rank: 0,
        capturedAt: null,
      },
      audit: {
        status: "none",
        pagesCrawled: 0,
        startedAt: null,
        issuesBySeverity: { critical: 0, warning: 0, info: 0 },
      },
      gsc: { connected: false },
      ga4: { connected: false },
    });
  });

  it("turns a failing section into an error code without failing the others", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getPerformance.mockRejectedValue(new GscApiError(500, "boom"));
    mocks.getBacklinkSummary.mockRejectedValue(new Error("d1 down"));
    mocks.getOrganicOverview.mockRejectedValue(
      new Ga4ReportError("ga4_quota_exhausted", "quota"),
    );
    mocks.runReport.mockResolvedValue({ rows: [] });

    expect(await PublicSummaryService.getSummary(input)).toMatchObject({
      gsc: { error: "gsc_upstream_unavailable" },
      backlinks: { error: "internal_error" },
      ga4: { error: "ga4_quota_exhausted" },
      audit: { status: "none" },
    });
  });

  it("shapes rankings, backlinks, audit, GSC and GA4 data", async () => {
    mocks.getConfigsForProject.mockResolvedValue([{ id: "cfg-1" }]);
    mocks.getLatestResults.mockResolvedValue({
      rows: [
        {
          keyword: "photo booth rental las vegas",
          desktop: { position: null, previousPosition: null, rankingUrl: null },
          mobile: {
            position: 4,
            previousPosition: 7,
            rankingUrl: "https://socialboothlv.com/",
          },
        },
      ],
      run: { lastCheckedAt: "2026-09-27 06:00:00" },
    });
    mocks.getBacklinkSummary.mockResolvedValue({
      rank: 12,
      backlinks: 340,
      referringDomains: 55,
      capturedAt: "2026-09-27T08:00:00.000Z",
    });
    mocks.getLatestAuditForProject.mockResolvedValue({
      id: "audit-1",
      status: "completed",
      pagesCrawled: 40,
      startedAt: "2026-09-20 10:00:00",
    });
    mocks.getIssueTypePageCountsForAudit.mockResolvedValue([
      { severity: "critical", pages: 2 },
      { severity: "critical", pages: 1 },
      { severity: "info", pages: 5 },
    ]);
    mocks.getPerformance.mockImplementation(
      async ({ dimensions }: { dimensions: string[] }) => ({
        rows: [
          {
            keys: [dimensions[0] === "query" ? "photo booth" : "2026-09-24"],
            clicks: 3,
            impressions: 100,
            ctr: 0.03,
            position: 8,
          },
        ],
      }),
    );
    mocks.getOrganicOverview.mockResolvedValue({
      current: {
        sessions: 50,
        activeUsers: 40,
        engagementRate: 0.6,
        keyEvents: 2,
      },
      previous: {
        sessions: 40,
        activeUsers: 30,
        engagementRate: 0.5,
        keyEvents: 1,
      },
      trend: [{ date: "20260924", sessions: 5 }],
    });
    mocks.runReport.mockResolvedValue({
      rows: [{ sessionSourceMedium: "google / organic", sessions: 30 }],
    });

    const summary = await PublicSummaryService.getSummary(input);

    expect(mocks.getLatestResults).toHaveBeenCalledWith(
      "cfg-1",
      "proj-a",
      "30d",
    );
    expect(mocks.runReport).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "traffic_acquisition",
        acquisitionBreakdown: "source_medium",
        channel: "all",
        startDate: "2026-08-29",
        endDate: "2026-09-25",
      }),
    );
    expect(summary).toMatchObject({
      rankings: {
        trackedKeywords: 1,
        top10: 1,
        improved: 1,
        declined: 0,
        lastCheckedAt: "2026-09-27T06:00:00.000Z",
        keywords: [
          {
            keyword: "photo booth rental las vegas",
            device: "mobile",
            position: 4,
            previousPosition: 7,
            url: "https://socialboothlv.com/",
          },
        ],
      },
      backlinks: {
        backlinks: 340,
        referringDomains: 55,
        rank: 12,
        capturedAt: "2026-09-27T08:00:00.000Z",
      },
      audit: {
        status: "completed",
        pagesCrawled: 40,
        startedAt: "2026-09-20T10:00:00.000Z",
        issuesBySeverity: { critical: 3, warning: 0, info: 5 },
      },
      gsc: {
        connected: true,
        totals: { clicks: 3, impressions: 100, ctr: 0.03, position: 8 },
        prevTotals: { clicks: 3, impressions: 100, ctr: 0.03, position: 8 },
        daily: [{ date: "2026-09-24", clicks: 3, impressions: 100 }],
        topQueries: [
          {
            query: "photo booth",
            clicks: 3,
            impressions: 100,
            ctr: 0.03,
            position: 8,
          },
        ],
      },
      ga4: {
        connected: true,
        totals: {
          sessions: 50,
          activeUsers: 40,
          engagementRate: 0.6,
          keyEvents: 2,
        },
        prevTotals: {
          sessions: 40,
          activeUsers: 30,
          engagementRate: 0.5,
          keyEvents: 1,
        },
        daily: [{ date: "2026-09-24", sessions: 5 }],
        sources: [{ source: "google", medium: "organic", sessions: 30 }],
      },
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec vitest run src/server/features/public-api/PublicSummaryService.test.ts
```
Expected: FAIL with `Failed to resolve import "./PublicSummaryService"`.

- [ ] **Step 3: Implement `PublicSummaryService.ts`**

```ts
import { sort } from "remeda";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { getIssueTypePageCountsForAudit } from "@/server/features/audit/repositories/auditSummaryQueries";
import { DashboardService } from "@/server/features/dashboard/services/DashboardService";
import { Ga4OrganicOverviewService } from "@/server/features/ga4/services/Ga4OrganicOverviewService";
import { Ga4ReportingService } from "@/server/features/ga4/services/Ga4ReportingService";
import {
  previousPeriod,
  sumSearchTotals,
  toDimensionRows,
} from "@/server/features/gsc/searchPerformanceReport";
import { GscService } from "@/server/features/gsc/services/GscService";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { summarizeRankResults } from "@/server/features/rank-tracking/services/rankSummary";
import { getLatestResults } from "@/server/features/rank-tracking/services/rankTrackingResults";
import { Ga4ReportError } from "@/server/lib/ga4Errors";
import {
  GscApiError,
  GscNotConnectedError,
  isExpectedGrantFailure,
} from "@/server/lib/gscErrors";
import {
  RANK_COMPARE_PERIOD,
  resolvePublicSummaryDates,
  type PublicSummaryRange,
} from "./publicSummaryRange";

// Read-only project summary for external dashboards (PAI-222). Every read is
// D1 or first-party Google data — never a DataForSEO-metered path (no
// ensureBacklinkSnapshot, AI visibility, or live SERP/opportunity calls).

// Same bound as the dashboard overview; projects rarely have more configs.
const MAX_CONFIGS = 5;
const KEYWORD_LIMIT = 100;
const TOP_QUERY_LIMIT = 10;
const SOURCE_LIMIT = 10;
// dimensions:["date"] returns one row per day; the longest range is 90 days.
const DAILY_ROW_LIMIT = 200;

type SummaryDates = { start: string; end: string };
type SectionError = { error: string };
type Ga4Row = Record<string, string | number | null> | null | undefined;

/** SQLite defaults store "YYYY-MM-DD HH:MM:SS" (UTC); Postgres and app writes
 *  store ISO. The wire contract is ISO. */
function toIsoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/** GA4 `date` dimension values are YYYYMMDD. */
function toIsoDate(value: string): string {
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`
    : value;
}

function metric(value: string | number | null | undefined): number {
  return typeof value === "number" ? value : 0;
}

function ga4Totals(row: Ga4Row) {
  return {
    sessions: metric(row?.sessions),
    activeUsers: metric(row?.activeUsers),
    engagementRate: metric(row?.engagementRate),
    keyEvents: metric(row?.keyEvents),
  };
}

/** GA4 sessionSourceMedium is "source / medium". */
function splitSourceMedium(value: string): { source: string; medium: string } {
  const separator = value.indexOf(" / ");
  return separator < 0
    ? { source: value, medium: "" }
    : { source: value.slice(0, separator), medium: value.slice(separator + 3) };
}

function sectionErrorCode(error: unknown): string {
  if (error instanceof Ga4ReportError) return error.code;
  if (error instanceof GscApiError) {
    return error.status === 429
      ? "gsc_quota_exhausted"
      : "gsc_upstream_unavailable";
  }
  return "internal_error";
}

function unwrap<T>(
  section: string,
  projectId: string,
  result: PromiseSettledResult<T>,
): T | SectionError {
  if (result.status === "fulfilled") return result.value;
  console.error(
    `public-summary: ${section} section failed`,
    { projectId },
    result.reason,
  );
  return { error: sectionErrorCode(result.reason) };
}

async function getRankings(projectId: string, range: PublicSummaryRange) {
  const configs = await RankTrackingRepository.getConfigsForProject(projectId);
  const results = await Promise.all(
    configs
      .slice(0, MAX_CONFIGS)
      .map((config) =>
        getLatestResults(config.id, projectId, RANK_COMPARE_PERIOD[range]),
      ),
  );
  const summary = summarizeRankResults(results);
  const keywords = results
    .flatMap((result) => result.rows)
    .flatMap((row) =>
      (["desktop", "mobile"] as const)
        .filter(
          (device) =>
            row[device].position !== null ||
            row[device].previousPosition !== null,
        )
        .map((device) => ({
          keyword: row.keyword,
          device,
          position: row[device].position,
          previousPosition: row[device].previousPosition,
          url: row[device].rankingUrl,
        })),
    );
  const unranked = Number.MAX_SAFE_INTEGER;
  return {
    ...summary,
    lastCheckedAt: toIsoTimestamp(summary.lastCheckedAt),
    // Best rank first; keywords that dropped out of the results (null) last.
    keywords: sort(
      keywords,
      (a, b) => (a.position ?? unranked) - (b.position ?? unranked),
    ).slice(0, KEYWORD_LIMIT),
  };
}

async function getBacklinks(projectId: string, domain: string | null) {
  // Stored snapshot only — refreshing it (ensureBacklinkSnapshot) is metered.
  const summary = await DashboardService.getBacklinkSummary(projectId, domain);
  return {
    backlinks: summary?.backlinks ?? 0,
    referringDomains: summary?.referringDomains ?? 0,
    rank: summary?.rank ?? 0,
    capturedAt: toIsoTimestamp(summary?.capturedAt),
  };
}

async function getAudit(projectId: string) {
  const issuesBySeverity = { critical: 0, warning: 0, info: 0 };
  const audit = await AuditRepository.getLatestAuditForProject(projectId);
  if (!audit) {
    return {
      status: "none" as const,
      pagesCrawled: 0,
      startedAt: null,
      issuesBySeverity,
    };
  }
  const typeRows = await getIssueTypePageCountsForAudit(audit.id);
  for (const row of typeRows) issuesBySeverity[row.severity] += row.pages;
  return {
    status: audit.status,
    pagesCrawled: audit.pagesCrawled,
    startedAt: toIsoTimestamp(audit.startedAt),
    issuesBySeverity,
  };
}

async function getGsc(projectId: string, dates: SummaryDates) {
  const prev = previousPeriod(dates.start, dates.end);
  try {
    const [current, previous, queries] = await Promise.all([
      GscService.getPerformance({
        projectId,
        startDate: dates.start,
        endDate: dates.end,
        dimensions: ["date"],
        rowLimit: DAILY_ROW_LIMIT,
      }),
      GscService.getPerformance({
        projectId,
        startDate: prev.startDate,
        endDate: prev.endDate,
        dimensions: ["date"],
        rowLimit: DAILY_ROW_LIMIT,
      }),
      GscService.getPerformance({
        projectId,
        startDate: dates.start,
        endDate: dates.end,
        dimensions: ["query"],
        rowLimit: TOP_QUERY_LIMIT,
      }),
    ]);
    return {
      connected: true as const,
      totals: sumSearchTotals(current.rows),
      prevTotals: sumSearchTotals(previous.rows),
      daily: current.rows.flatMap((row) => {
        const date = row.keys?.[0];
        return date
          ? [{ date, clicks: row.clicks, impressions: row.impressions }]
          : [];
      }),
      topQueries: toDimensionRows(queries.rows).map(({ key, ...values }) => ({
        query: key,
        ...values,
      })),
    };
  } catch (error) {
    // Unlinked, or a dead/denied grant: the same "connect" state the in-app
    // Search Performance page shows (searchPerformance.ts).
    if (error instanceof GscNotConnectedError || isExpectedGrantFailure(error)) {
      return { connected: false as const };
    }
    throw error;
  }
}

async function getGa4(projectId: string, dates: SummaryDates) {
  try {
    const [overview, sources] = await Promise.all([
      // Organic Search only (the SEO lens).
      Ga4OrganicOverviewService.getOrganicOverview({
        projectId,
        startDate: dates.start,
        endDate: dates.end,
        trend: "daily",
      }),
      // All channels, so the consumer can see where traffic comes from.
      Ga4ReportingService.runReport({
        projectId,
        kind: "traffic_acquisition",
        acquisitionBreakdown: "source_medium",
        channel: "all",
        startDate: dates.start,
        endDate: dates.end,
        limit: SOURCE_LIMIT,
      }),
    ]);
    return {
      connected: true as const,
      totals: ga4Totals(overview.current),
      prevTotals: ga4Totals(overview.previous),
      daily: overview.trend.map((row) => ({
        date: toIsoDate(String(row.date ?? "")),
        sessions: metric(row.sessions),
      })),
      sources: sources.rows.map((row) => ({
        ...splitSourceMedium(String(row.sessionSourceMedium ?? "")),
        sessions: metric(row.sessions),
      })),
    };
  } catch (error) {
    if (error instanceof Ga4ReportError && error.code === "ga4_not_connected") {
      return { connected: false as const };
    }
    throw error;
  }
}

async function getSummary(input: {
  projectId: string;
  range: PublicSummaryRange;
  now?: Date;
}) {
  const found = await ProjectService.getProjectWithOrganization(
    input.projectId,
  );
  if (!found) return null;
  const { project } = found;
  const now = input.now ?? new Date();
  const dates = resolvePublicSummaryDates(input.range, now);

  const [rankings, backlinks, audit, gsc, ga4] = await Promise.allSettled([
    getRankings(project.id, input.range),
    getBacklinks(project.id, project.domain),
    getAudit(project.id),
    getGsc(project.id, dates),
    getGa4(project.id, dates),
  ]);

  return {
    project: { id: project.id, domain: project.domain },
    generatedAt: now.toISOString(),
    range: dates,
    rankings: unwrap("rankings", project.id, rankings),
    backlinks: unwrap("backlinks", project.id, backlinks),
    audit: unwrap("audit", project.id, audit),
    gsc: unwrap("gsc", project.id, gsc),
    ga4: unwrap("ga4", project.id, ga4),
  };
}

export const PublicSummaryService = { getSummary };
```

If `tsc` rejects `overview.current`/`overview.trend`/`sources.rows` because the inferred return types include `undefined` (the `catch { mapGa4ReportError(error); }` branch), check `Ga4OrganicOverviewService.ts:152-154`. `mapGa4ReportError` is declared `: never` (`Ga4ReportingService.ts:131`), so this should not happen. If it does, narrow with `if (!overview || !sources) throw new Error("ga4: empty report")` instead of using non-null assertions.

- [ ] **Step 4: Run it to verify it passes, and typecheck**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec vitest run src/server/features/public-api/PublicSummaryService.test.ts && pnpm exec tsc --noEmit
```
Expected: PASS (4 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec prettier --write src/server/features/public-api/PublicSummaryService.ts src/server/features/public-api/PublicSummaryService.test.ts && git add src/server/features/public-api/PublicSummaryService.ts src/server/features/public-api/PublicSummaryService.test.ts && git commit -m "$(cat <<'EOF'
feat(public-api): assemble per-section project summary with allSettled (PAI-222)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: HTTP handler

**Files:**
- Create: `src/server/features/public-api/publicSummaryHandler.test.ts`
- Create: `src/server/features/public-api/publicSummaryHandler.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handlePublicSummaryRequest } from "./publicSummaryHandler";

const mocks = vi.hoisted(() => ({ getSummary: vi.fn() }));

vi.mock("./PublicSummaryService", () => ({
  PublicSummaryService: { getSummary: mocks.getSummary },
}));

const KEY = "k".repeat(64);
const RAW_KEYS = `${KEY}:proj-a`;

function call(
  options: {
    projectId?: string;
    query?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const projectId = options.projectId ?? "proj-a";
  return handlePublicSummaryRequest({
    request: new Request(
      `https://seo.test/api/public/v1/projects/${projectId}/summary${options.query ?? ""}`,
      { headers: options.headers ?? { authorization: `Bearer ${KEY}` } },
    ),
    projectId,
    rawKeys: RAW_KEYS,
  });
}

describe("handlePublicSummaryRequest", () => {
  beforeEach(() => {
    mocks.getSummary.mockResolvedValue({ project: { id: "proj-a" } });
  });

  it("returns 401 for an unknown key without touching data", async () => {
    const response = await call({
      headers: { authorization: `Bearer ${"x".repeat(64)}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.getSummary).not.toHaveBeenCalled();
  });

  it("returns 200 with only a valid X-OpenSEO-Key header", async () => {
    expect((await call({ headers: { "x-openseo-key": KEY } })).status).toBe(
      200,
    );
  });

  it("returns 401 with only a wrong X-OpenSEO-Key header", async () => {
    const response = await call({ headers: { "x-openseo-key": "wrong" } });
    expect(response.status).toBe(401);
    expect(mocks.getSummary).not.toHaveBeenCalled();
  });

  it("returns 200 when the Bearer key is wrong but X-OpenSEO-Key is valid", async () => {
    const response = await call({
      headers: { authorization: "Bearer wrong", "x-openseo-key": KEY },
    });
    expect(response.status).toBe(200);
  });

  it("returns 404 when the key is bound to a different project", async () => {
    const response = await call({ projectId: "proj-b" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mocks.getSummary).not.toHaveBeenCalled();
  });

  it("returns 422 for an unsupported range", async () => {
    const response = await call({ query: "?range=last_3_months" });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid_range" });
  });

  it("returns the summary for the default range with a private no-cache header", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=0");
    expect(await response.json()).toEqual({ project: { id: "proj-a" } });
    expect(mocks.getSummary).toHaveBeenCalledWith({
      projectId: "proj-a",
      range: "last_28_days",
    });
  });

  it("returns 404 when the bound project no longer exists", async () => {
    mocks.getSummary.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it("returns a generic 500 when the summary throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getSummary.mockRejectedValue(new Error("db down"));
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec vitest run src/server/features/public-api/publicSummaryHandler.test.ts
```
Expected: FAIL with `Failed to resolve import "./publicSummaryHandler"`.

- [ ] **Step 3: Implement `publicSummaryHandler.ts`**

```ts
import { parsePublicApiKeys, resolveBoundProjects } from "./publicApiAuth";
import { parsePublicSummaryRange } from "./publicSummaryRange";
import { PublicSummaryService } from "./PublicSummaryService";

// The consumer caches on its side; never let an intermediary store a
// key-authenticated response.
const CACHE_HEADERS = { "Cache-Control": "private, max-age=0" };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: CACHE_HEADERS });
}

/** Trust boundary for the public summary route: a key (Authorization: Bearer
 *  or X-OpenSEO-Key) bound to exactly one project (OPENSEO_PUBLIC_API_KEYS).
 *  Deliberately independent of the Cloudflare Access user JWT — service-token
 *  JWTs carry no email. */
export async function handlePublicSummaryRequest(input: {
  request: Request;
  projectId: string;
  rawKeys: string | undefined;
}): Promise<Response> {
  const boundProjects = resolveBoundProjects(
    input.request.headers,
    parsePublicApiKeys(input.rawKeys),
  );
  if (boundProjects.size === 0) return json({ error: "unauthorized" }, 401);
  // A valid key for another project must not reveal whether this one exists.
  if (!boundProjects.has(input.projectId)) {
    return json({ error: "not_found" }, 404);
  }

  const range = parsePublicSummaryRange(
    new URL(input.request.url).searchParams.get("range"),
  );
  if (!range) return json({ error: "invalid_range" }, 422);

  try {
    const summary = await PublicSummaryService.getSummary({
      projectId: input.projectId,
      range,
    });
    return summary ? json(summary, 200) : json({ error: "not_found" }, 404);
  } catch (error) {
    console.error(
      "public-summary: request failed",
      { projectId: input.projectId },
      error,
    );
    return json({ error: "internal_error" }, 500);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec vitest run src/server/features/public-api
```
Expected: PASS (all 4 public-api files, 27 tests: auth 10, range 4, service 4, handler 9).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec prettier --write src/server/features/public-api/publicSummaryHandler.ts src/server/features/public-api/publicSummaryHandler.test.ts && git add src/server/features/public-api/publicSummaryHandler.ts src/server/features/public-api/publicSummaryHandler.test.ts && git commit -m "$(cat <<'EOF'
feat(public-api): key-authenticated summary request handler (PAI-222)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Route file, secret wiring, full checks

**Files:**
- Create: `src/routes/api/public/v1/projects/$projectId/summary.ts`
- Regenerated: `src/routeTree.gen.ts`
- Modify: `src/env.d.ts` (after `OPENROUTER_MODEL?: string;`, line 64)
- Modify: `alchemy.run.ts` (`dataEnv`, after `GDPR_ERASURE_SECRET: optionalSecret("GDPR_ERASURE_SECRET"),`, line 278)
- Modify: `.env.selfhost.example` (after the `SELFHOST_DOMAINS` block)

- [ ] **Step 1: Create the route file** at `src/routes/api/public/v1/projects/$projectId/summary.ts`. Keep the literal `$` in the directory name; quote the path in bash (`'src/routes/api/public/v1/projects/$projectId/summary.ts'`).

```ts
import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { isHostedAuthMode } from "@/lib/auth-mode";
import { handlePublicSummaryRequest } from "@/server/features/public-api/publicSummaryHandler";

// Read-only, key-authenticated project summary for external dashboards
// (PAI-222). A raw route: it establishes its own trust boundary (a key in
// Authorization: Bearer or X-OpenSEO-Key, bound to one project via
// OPENSEO_PUBLIC_API_KEYS) and never reads the
// Cloudflare Access user JWT. In the self-host deploy a path-scoped Access
// application with a service-token policy also fronts /api/public/*.
// Self-host only — hosted mode answers 404.
export const Route = createFileRoute(
  "/api/public/v1/projects/$projectId/summary",
)({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        if (isHostedAuthMode(env.AUTH_MODE)) {
          return new Response("Not found", { status: 404 });
        }
        return handlePublicSummaryRequest({
          request,
          projectId: params.projectId,
          rawKeys: env.OPENSEO_PUBLIC_API_KEYS,
        });
      },
    },
  },
});
```

If `tsc` reports the handler context as implicitly `any` after regeneration, annotate it the way `src/routes/api/auth/$.ts:26` does: `({ request, params }: { request: Request; params: { projectId: string } })`.

- [ ] **Step 2: Type the binding in `src/env.d.ts`** (after line 64):

```ts
    // Read-only public summary API keys, "key:projectId[,key:projectId]"
    // (src/server/features/public-api). Unset = every request is 401.
    OPENSEO_PUBLIC_API_KEYS?: string;
```

- [ ] **Step 3: Deploy the secret in `alchemy.run.ts`** (inside `dataEnv`, after the `GDPR_ERASURE_SECRET` line 278; `dataEnv` is spread into the app worker at `:471`, and deliberately not into the audit worker at `:396-403`):

```ts
  OPENSEO_PUBLIC_API_KEYS: optionalSecret("OPENSEO_PUBLIC_API_KEYS"),
```

- [ ] **Step 4: Document it in `.env.selfhost.example`** (after the `# SELFHOST_DOMAINS=seo.example.com` line):

```bash

# Read-only project summary API for external dashboards:
#   GET /api/public/v1/projects/<project-id>/summary
#   Authorization: Bearer <key>   (or X-OpenSEO-Key: <key>)
# Each key is bound to one project (key:projectId); comma-separate several.
# Generate keys with `openssl rand -hex 32` (32+ characters). Unset = the
# endpoint answers 401. Front /api/public/* with a service-token Access app.
# OPENSEO_PUBLIC_API_KEYS=<key>:<project-id>
```

- [ ] **Step 5: Regenerate the route tree and run the full gate**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm build && git status --short src/routeTree.gen.ts && grep -c "api/public/v1/projects/\$projectId/summary" src/routeTree.gen.ts
```
Expected: the build succeeds, `routeTree.gen.ts` shows as modified, and grep prints a count ≥ 1.

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && pnpm exec prettier --write 'src/routes/api/public/v1/projects/$projectId/summary.ts' src/env.d.ts alchemy.run.ts && pnpm test && pnpm lint && pnpm knip && pnpm format:check
```
Expected: all green. If `knip` flags an export introduced by this plan, un-export it (keep it module-local). Do not add knip ignores.

- [ ] **Step 6: Commit**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 && git add 'src/routes/api/public/v1/projects/$projectId/summary.ts' src/routeTree.gen.ts src/env.d.ts alchemy.run.ts .env.selfhost.example && git commit -m "$(cat <<'EOF'
feat(public-api): GET /api/public/v1/projects/$projectId/summary route + OPENSEO_PUBLIC_API_KEYS secret (PAI-222)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Manual security read, then local fast-forward merge

**Files:** none changed (review only)

`.greptile/rules.md:67` requires a manual security read for auth changes and secret-bearing paths.

- [ ] **Step 1: Read the full branch diff** (`git -C /c/Users/Brizzle/projects/tools/_active/open-seo-PAI-222 diff main...HEAD`) and confirm each point. Fix any gap with a new TDD step before continuing.
  1. The route never calls `ensureUser` / `requireProjectContext` / `resolveUserContextFromHeaders`.
  2. A 401 happens before any DB read. The project-mismatch 404 happens before any DB read.
  3. The key compare goes through `timingSafeEqual` for every presented key (Bearer, then `X-OpenSEO-Key`) against every configured key, with no early return. When the two headers disagree, a request succeeds only if one of the presented keys is bound to the requested project.
  4. Short or malformed keys are ignored, so an empty or unset secret means everything returns 401.
  5. No response body or log line includes the key, the `Authorization` / `X-OpenSEO-Key` headers, or Google tokens. `console.error` logs only `{ projectId }` + the error.
  6. No import path reaches `ensureBacklinkSnapshot`, `createDataforseoClient`, AI-search or opportunity services. Check with `grep -rn "ensureBacklinkSnapshot\|createDataforseoClient\|ai-search\|SearchOpportunity" src/server/features/public-api`, which must print nothing. `DashboardService.ts` itself imports `createDataforseoClient` (for `ensureBacklinkSnapshot`), so the public API reaches that import transitively through `DashboardService`. This is intentional and safe: only `DashboardService.getBacklinkSummary` is called, a pure D1 read, and no spending method is invoked. Record this in the security read.
  7. The hosted build returns 404.
  8. `storage-erasure.ts` behavior is unchanged: same comparison, now imported.
  9. No control-plane file changed: `git diff --name-only main...HEAD | grep -E '^(\.greptile/|AGENTS\.md|CLAUDE\.md|\.agents/skills/|\.github/)'` must print nothing.

- [ ] **Step 2: Fast-forward `main` locally.** Nothing is pushed yet; the deploy runs from the main checkout.

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo && git status --short && git merge --ff-only PAI-222/public-summary-api && git log --oneline -10
```
Expected: the tree is clean before the merge and the fast-forward succeeds. The log shows the PAI-222 commits on top of `43e9ae3`: the plan-doc commits (`docs(plan): PAI-222 public summary API` and `docs(plan): PAI-222 review fixes`) plus the 6 implementation commits from Tasks 2-7 (refactor, auth, range, service, handler, route), 8 in total. Adjust the count if any task was split.

---

### Task 9: Generate the key and deploy from the main checkout (Windows-safe path)

**Files:** `.env.selfhost` (gitignored; never committed, never printed)

- [ ] **Step 1: Generate the key into `.env.selfhost` without printing it**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo && if grep -q '^OPENSEO_PUBLIC_API_KEYS=' .env.selfhost; then echo "already set — not regenerating"; else KEY=$(openssl rand -hex 32) && printf '\n# PAI-222 public summary API (SBLV admin)\nOPENSEO_PUBLIC_API_KEYS=%s:c65ed7c9-ee05-4b6d-a61f-8817c7a003ae\n' "$KEY" >> .env.selfhost && unset KEY && echo "added"; fi; grep -c '^OPENSEO_PUBLIC_API_KEYS=' .env.selfhost
```
Expected: `added` (or `already set`), then `1`.

- [ ] **Step 2: Snapshot the FULL email Access app and install the restore helper.** Alchemy re-provisions this app on deploy (see Facts). The app is found by name/domain, not by a hard-coded id, in case alchemy ever recreates it.

2a. Write the helper files. They contain no secrets and are reused by Step 4 and by Rollback.

```bash
D="$HOME/.pai222" && mkdir -p "$D" && cat > "$D/find_email_app.py" <<'PY'
# stdin: GET /access/apps?per_page=100 ; stdout: id of the alchemy email app
import json, sys
apps = json.load(sys.stdin)["result"]
match = [a for a in apps
         if a.get("name") == "open-seo selfhost"
         or a.get("domain") == "open-seo-selfhost.bryan-rivera-bfd.workers.dev"]
if len(match) != 1:
    sys.exit("expected exactly one email app (name 'open-seo selfhost' / workers.dev domain), found %d" % len(match))
print(match[0]["id"])
PY
cat > "$D/restore_email_app.py" <<'PY'
# stdin: GET /access/apps/{live id}  ; env: SNAP_W (Windows path of the saved
# snapshot), REUSABLE_IDS (comma list from GET /access/policies), FORCE=1 to
# rebuild even when the live destinations look right.
# stdout: the PUT body (empty = nothing to do); diagnostics go to stderr.
import json, os, sys
live = json.load(sys.stdin)["result"]
snap = json.load(open(os.environ["SNAP_W"], encoding="utf-8"))
live_uris = [d["uri"] for d in live.get("destinations", [])]
snap_uris = [d["uri"] for d in snap.get("destinations", [])]
print("live destinations:", live_uris, "| snapshot:", snap_uris, file=sys.stderr)
if set(snap_uris) <= set(live_uris) and os.environ.get("FORCE") != "1":
    sys.exit(0)

# Full saved object, read-only/server-computed fields stripped. The only field
# we intend to change vs. live is `destinations` (back to the snapshot's).
READ_ONLY = {"id", "uid", "aud", "created_at", "updated_at", "policies",
             "self_hosted_domains"}  # self_hosted_domains is derived from destinations
body = {k: v for k, v in snap.items() if k not in READ_ONLY}
body["destinations"] = snap["destinations"]

reusable = set(filter(None, os.environ.get("REUSABLE_IDS", "").split(",")))
def policy_ref(p, i):
    if p.get("reusable") is True or p["id"] in reusable:
        # Account-level (reusable) policy: reference it, never re-send its body.
        return {"id": p["id"], "precedence": p.get("precedence", i + 1)}
    # Legacy app-scoped policy: re-send inline without server-owned fields.
    return {k: v for k, v in p.items()
            if k not in {"id", "uid", "created_at", "updated_at", "app_count", "reusable"}}
snap_policies = snap.get("policies", [])
if any(p.get("reusable") is True and p["id"] not in reusable for p in snap_policies):
    # A reusable policy from the snapshot was deleted (e.g. alchemy recreated
    # it under a new id); referencing it would fail the PUT.
    print("WARNING: a snapshot reusable policy no longer exists; keeping live policies", file=sys.stderr)
    snap_policies = live.get("policies", [])
body["policies"] = [policy_ref(p, i) for i, p in enumerate(snap_policies)]
changed = sorted(k for k in body if k != "policies" and live.get(k) != body[k])
print("fields that will change vs. live:", changed, file=sys.stderr)
json.dump(body, sys.stdout)
PY
cat > "$D/restore-email-app.sh" <<'SH'
#!/usr/bin/env bash
# Usage: FORCE=0|1 bash "$HOME/.pai222/restore-email-app.sh"
set -euo pipefail
D="$HOME/.pai222"
cd /c/Users/Brizzle/projects/tools/_active/open-seo
set -a; . ./.env.selfhost; set +a
BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access"
AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
APP_ID=$(curl -s "${AUTH[@]}" "$BASE/apps?per_page=100" | python "$(cygpath -w "$D/find_email_app.py")")
REUSABLE_IDS=$(curl -s "${AUTH[@]}" "$BASE/policies?per_page=100" | python -c "import json,sys; print(','.join(p['id'] for p in json.load(sys.stdin)['result']))")
curl -s "${AUTH[@]}" "$BASE/apps/$APP_ID" > "$D/email-app.live.json"
SNAP_W="$(cygpath -w "$D/email-app.snapshot.json")" REUSABLE_IDS="$REUSABLE_IDS" FORCE="${FORCE:-0}" \
  python "$(cygpath -w "$D/restore_email_app.py")" < "$D/email-app.live.json" > "$D/email-app.put.json"
if [ -s "$D/email-app.put.json" ]; then
  curl -s -X PUT "${AUTH[@]}" -H "Content-Type: application/json" --data-binary @- "$BASE/apps/$APP_ID" < "$D/email-app.put.json" \
    | python -c "import json,sys; d=json.load(sys.stdin); r=d.get('result') or {}; print('RESTORED', d['success'], d.get('errors'), [x['uri'] for x in r.get('destinations',[])])"
else
  echo "destinations intact (app $APP_ID) — no restore"
fi
rm -f "$D/email-app.live.json" "$D/email-app.put.json"
SH
ls "$D"
```
Expected: `find_email_app.py  restore-email-app.sh  restore_email_app.py`.

2b. Save the full snapshot. Bash does every file write; python only filters stdin to stdout.

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo && set -a && . ./.env.selfhost && set +a && D="$HOME/.pai222" && BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access" && APP_ID=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE/apps?per_page=100" | python "$(cygpath -w "$D/find_email_app.py")") && curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE/apps/$APP_ID" | python -c "import json,sys; d=json.load(sys.stdin); assert d['success'], d.get('errors'); json.dump(d['result'], sys.stdout)" > "$D/email-app.snapshot.json" && python -c "import json,sys; a=json.load(sys.stdin); print(a['id'], a['name'], [d['uri'] for d in a.get('destinations',[])], [(p.get('name'), p.get('reusable')) for p in a.get('policies',[])])" < "$D/email-app.snapshot.json"
```
Expected: `0f0045d6-c514-4f7e-8beb-272de8318848 open-seo selfhost ['open-seo-selfhost.bryan-rivera-bfd.workers.dev', 'seo.bryanrivera.ai'] [('open-seo selfhost self-host users', True)]`. The flag may print `None` if the API omits `reusable`; the helper then falls back to the `/access/policies` id list. **Record the app id in the ticket log.** If the snapshot does not include `seo.bryanrivera.ai`, stop: the gate is already broken, and restoring from this snapshot would not fix it.

- [ ] **Step 3: Deploy.** Run the `deploy:selfhost` steps by hand in Git Bash; this works around the cmd.exe `NODE_OPTIONS` papercut from `43e9ae3`.

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo && node scripts/selfhost-deploy-preflight.mjs && pnpm exec vite build --mode selfhost && pnpm exec tsc --noEmit && NODE_OPTIONS="--max-old-space-size=4096 --experimental-strip-types" ./node_modules/.bin/alchemy deploy --env-file .env.selfhost --stage selfhost
```
Run it with a 600000 ms timeout. Expected: alchemy reports the `open-seo-selfhost` worker updated and no resources deleted.

Fallbacks, in order:
1. `pnpm --config.script-shell="C:\\Program Files\\Git\\bin\\bash.exe" deploy:selfhost` makes pnpm run the script under bash.
2. If alchemy fails for a reason other than `NODE_OPTIONS`, stop and report the last 40 lines of output. **Do not** use `wrangler deploy` as a fallback: alchemy owns the bindings, secrets and state, and a wrangler deploy would drift from them.
3. The same failure twice means stop and report (browser-automation rule: stop after 2 identical failures).

- [ ] **Step 4: Re-check the email app's destinations and restore them if alchemy dropped the custom host**

```bash
FORCE=0 bash "$HOME/.pai222/restore-email-app.sh"
```
The script finds the live app by name/domain. If the live destinations are missing any of the snapshot's, it PUTs the **full saved snapshot** back to the live app id. Read-only fields (`id`, `uid`, `aud`, `created_at`, `updated_at`, `self_hosted_domains`) are stripped. Reusable policies are sent as `{id, precedence}` references, and legacy app-scoped policies are sent inline with their server fields stripped. It prints `fields that will change vs. live:`, which should be `['destinations']` only; anything else means alchemy changed the app and should be noted.

Expected: `destinations intact (app <id>) — no restore`, or `RESTORED True [] [..., 'seo.bryanrivera.ai']`. Run the smoke test in Step 5 after either outcome. If the restore was needed, note in the ticket log that every alchemy deploy drops the hand-added hostname (a follow-up ticket could teach `emailAccessGate` about `SELFHOST_DOMAINS`).

- [ ] **Step 5: Smoke test through the email gate.** The route exists and Access still blocks anonymous requests.

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://seo.bryanrivera.ai/api/public/v1/projects/c65ed7c9-ee05-4b6d-a61f-8817c7a003ae/summary
```
Expected: `401` (Access edge `invalid_token`; the path app does not exist yet).

---

### Task 10: Cloudflare Access: service token + path-scoped service-auth app

**Files:** none in the repo. The Access resources are created via the Cloudflare API because the custom-domain gate is hand-managed; alchemy provisions only the workers.dev email app (`alchemy.run.ts` `resolveSelfHostAccess` → `alchemy.access.ts:61-81`). The path-scoped app is left out of alchemy on purpose, so a deploy can never delete it.

- [ ] **Step 1: Create the service token.** Python writes the id and secret to **stdout**, which bash redirects into `$D/cf.env`; status goes to stderr. Nothing secret reaches the terminal. `$D` is not permission-protected on NTFS, and Task 12 deletes the file.

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo && set -a && . ./.env.selfhost && set +a && D="$HOME/.pai222" && mkdir -p "$D" && curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/service_tokens" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" --data '{"name":"sblv-admin-openseo","duration":"8760h"}' | python -c "
import json,sys
d=json.load(sys.stdin); r=d.get('result') or {}
print('success', d.get('success'), d.get('errors'), 'token_id', r.get('id'), 'expires_at', r.get('expires_at'), file=sys.stderr)
if not d.get('success'): sys.exit(1)
sys.stdout.write('CF_SVC_TOKEN_ID=%s\nCF_CLIENT_ID=%s\nCF_CLIENT_SECRET=%s\n' % (r['id'], r['client_id'], r['client_secret']))
" > "$D/cf.env"; grep -c '^CF_CLIENT_SECRET=.' "$D/cf.env" && grep '^CF_SVC_TOKEN_ID=' "$D/cf.env" >> "$D/ids.env"
```
`$D/ids.env` holds only non-secret resource ids, for the ticket log and for Rollback.
Expected: stderr shows `success True [] token_id <uuid> expires_at <date ~2027-09-28>`, then `1`. Record `token_id` and `expires_at` for the ticket log. If the output is `0`, delete the empty file (`rm -f "$HOME/.pai222/cf.env"`) before retrying.

If the call returns `success False` with an auth error, the API token lacks Access write scopes. Stop and ask Bryan to add **Access: Service Tokens Edit** and **Access: Apps and Policies Edit** to the token behind `CLOUDFLARE_API_TOKEN` (Cloudflare dashboard → My Profile → API Tokens), then re-run. Do not create the token in the dashboard, where the secret would have to be copied by hand.

- [ ] **Step 2: Create a reusable `non_identity` policy and the path-scoped app**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo && D="$HOME/.pai222" && set -a && . ./.env.selfhost && . "$D/cf.env" && set +a && BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access" && POLICY_ID=$(curl -s -X POST "$BASE/policies" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" --data "{\"name\":\"sblv-admin-openseo service token\",\"decision\":\"non_identity\",\"include\":[{\"service_token\":{\"token_id\":\"$CF_SVC_TOKEN_ID\"}}]}" | python -c "import json,sys; d=json.load(sys.stdin); print(d['result']['id'] if d.get('success') else 'ERR '+json.dumps(d.get('errors')))") && echo "policy $POLICY_ID" && case "$POLICY_ID" in ERR*) exit 1;; esac && echo "ACCESS_POLICY_ID=$POLICY_ID" >> "$D/ids.env" && APP_ID=$(curl -s -X POST "$BASE/apps" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" --data "{\"type\":\"self_hosted\",\"name\":\"open-seo public API (service token)\",\"domain\":\"seo.bryanrivera.ai/api/public\",\"destinations\":[{\"type\":\"public\",\"uri\":\"seo.bryanrivera.ai/api/public\"}],\"app_launcher_visible\":false,\"session_duration\":\"24h\",\"policies\":[{\"id\":\"$POLICY_ID\",\"precedence\":1}]}" | python -c "
import json,sys; d=json.load(sys.stdin); r=d.get('result') or {}
print('app', d.get('success'), d.get('errors'), r.get('id'), [x.get('uri') for x in r.get('destinations',[])], [p.get('decision') for p in r.get('policies',[])], file=sys.stderr)
print(r.get('id') or 'ERR')") && case "$APP_ID" in ERR*) exit 1;; esac && echo "ACCESS_APP_ID=$APP_ID" >> "$D/ids.env" && cat "$D/ids.env"
```
Expected: `policy <uuid>`, then `app True [] <uuid> ['seo.bryanrivera.ai/api/public'] ['non_identity']`, then `ids.env` listing `CF_SVC_TOKEN_ID`, `ACCESS_POLICY_ID`, `ACCESS_APP_ID` (non-secret; printing them is fine). Record all three for the ticket log. If the app POST fails after the policy was created, run Rollback R1 for the policy before retrying.

Access applies the most specific path, so `seo.bryanrivera.ai/api/public/*` now uses the service-token app only, and every other path keeps the email app. Access path apps cover sub-paths, as the existing `crm.bryanrivera.ai/rest` app shows.

---

### Task 11: Live verification (no secrets echoed)

**Files:** none

- [ ] **Step 1: Run the matrix.** Wait about 30 s after Task 10 for Access propagation. If check 1 still shows the old behavior, wait again and retry once.

All response bodies stay in bash variables (`$(curl …)`), so no temp files are needed and python reads only stdin.

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo && D="$HOME/.pai222" && set -a && . "$D/cf.env" && set +a && KEY=$(grep '^OPENSEO_PUBLIC_API_KEYS=' .env.selfhost | cut -d= -f2- | cut -d, -f1 | cut -d: -f1) && PID=c65ed7c9-ee05-4b6d-a61f-8817c7a003ae && BASEURL="https://seo.bryanrivera.ai/api/public/v1/projects" && CF=(-H "CF-Access-Client-Id: $CF_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET") && \
hit() { local label="$1"; shift; local out; out=$(curl -s -w $'\n%{http_code}' "$@"); printf '%-28s -> %s %s\n' "$label" "${out##*$'\n'}" "$(printf '%s' "${out%$'\n'*}" | head -c 140)"; } && \
hit "1 no CF, Bearer ok"         -H "Authorization: Bearer $KEY" "$BASEURL/$PID/summary" && \
hit "2 CF + wrong Bearer"        "${CF[@]}" -H "Authorization: Bearer wrong" "$BASEURL/$PID/summary" && \
hit "3 CF + other project"       "${CF[@]}" -H "Authorization: Bearer $KEY" "$BASEURL/00000000-0000-0000-0000-000000000000/summary" && \
hit "4 CF + bad range"           "${CF[@]}" -H "Authorization: Bearer $KEY" "$BASEURL/$PID/summary?range=last_3_months" && \
hit "5x CF + X-OpenSEO-Key only" "${CF[@]}" -H "X-OpenSEO-Key: $KEY" "$BASEURL/$PID/summary?range=last_7_days" && \
hit "5y CF + wrong X-header only" "${CF[@]}" -H "X-OpenSEO-Key: wrong" "$BASEURL/$PID/summary" && \
hit "5z CF + bad Bearer, good X" "${CF[@]}" -H "Authorization: Bearer wrong" -H "X-OpenSEO-Key: $KEY" "$BASEURL/$PID/summary" && \
OUT=$(curl -s -i "${CF[@]}" -H "Authorization: Bearer $KEY" -H "X-OpenSEO-Key: $KEY" "$BASEURL/$PID/summary?range=last_28_days") && \
printf '%s' "$OUT" | grep -iE '^HTTP/|^cache-control' && \
printf '%s' "$OUT" | tr -d '\r' | awk 'f;/^$/{f=1}' | python -c "
import json,sys; d=json.load(sys.stdin)
print('keys', sorted(d)); print('project', d['project'], 'range', d['range'])
for s in ('rankings','backlinks','audit','gsc','ga4'):
    v=d[s]; print(s, {k:(len(x) if isinstance(x,list) else x) for k,x in v.items() if not isinstance(x,dict)})
" && \
curl -s -o /dev/null -w "6 app root (browser)          -> %{http_code} %{redirect_url}\n" -H "Accept: text/html" https://seo.bryanrivera.ai/ | cut -c1-120 && \
curl -s -o /dev/null -w "7 CF headers on /api/health   -> %{http_code}\n" "${CF[@]}" https://seo.bryanrivera.ai/api/health; \
unset KEY CF OUT
```

Expected:

| # | Expect |
|---|---|
| 1 | `401` or `403` from the Access edge: body `{"error":"invalid_token",…}` or HTML, **not** `{"error":"unauthorized"}` |
| 2 | `401 {"error":"unauthorized"}` (the worker) |
| 3 | `404 {"error":"not_found"}` |
| 4 | `422 {"error":"invalid_range"}` |
| 5x | `200` with only `X-OpenSEO-Key` (the consumer's second header is sufficient on its own) |
| 5y | `401 {"error":"unauthorized"}` with only a wrong `X-OpenSEO-Key` |
| 5z | `200`: wrong Bearer plus valid `X-OpenSEO-Key` is accepted |
| 5 (full) | Both headers, as the consumer sends them: `HTTP/… 200`; `cache-control: private, max-age=0`; keys `audit, backlinks, ga4, generatedAt, gsc, project, range, rankings`; `project.domain` = `socialboothlv.com`; no section shows `error` (an `error` section is acceptable only if its code explains it, e.g. `ga4_reconnect_required`; record it) |
| 6 | `302 https://dark-sea-f641.cloudflareaccess.com/…`: the rest of the app is still email-gated |
| 7 | `401`/`403`: the service token does **not** open non-`/api/public` paths |

If checks 2/1 show Access consuming the `Authorization: Bearer` header (an Access `invalid_token` instead of the worker's `unauthorized`), 5x and 5z still prove the contract works through `X-OpenSEO-Key`, which the consumer always sends. Record this in the ticket and continue; see Open risk 2. If 5x fails, stop and report.

---

### Task 12: SBLV Vercel env vars (production + preview), then shred the temp file

**Files:** none in either repo (Vercel project settings only)

- [ ] **Step 1: Add the five vars.** Values come from stdin; nothing is printed.

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo && set -a && . "$HOME/.pai222/cf.env" && set +a && KEY=$(grep '^OPENSEO_PUBLIC_API_KEYS=' .env.selfhost | cut -d= -f2- | cut -d, -f1 | cut -d: -f1) && cd /c/Users/Brizzle/projects/clients/socialbooth-lv/socialboothlv-site && for T in production preview; do \
printf '%s' "$KEY" | vercel env add OPENSEO_API_KEY "$T" --sensitive --yes --force >/dev/null && \
printf '%s' "$CF_CLIENT_ID" | vercel env add CF_ACCESS_CLIENT_ID "$T" --sensitive --yes --force >/dev/null && \
printf '%s' "$CF_CLIENT_SECRET" | vercel env add CF_ACCESS_CLIENT_SECRET "$T" --sensitive --yes --force >/dev/null && \
printf '%s' "https://seo.bryanrivera.ai" | vercel env add OPENSEO_API_URL "$T" --no-sensitive --yes --force >/dev/null && \
printf '%s' "c65ed7c9-ee05-4b6d-a61f-8817c7a003ae" | vercel env add OPENSEO_PROJECT_ID "$T" --no-sensitive --yes --force >/dev/null && echo "$T ok"; done; unset KEY; vercel env ls 2>/dev/null | grep -E "OPENSEO_|CF_ACCESS_"
```
Expected: `production ok`, `preview ok`, and `vercel env ls` lists all five names for Production and Preview. The values show as Encrypted or Sensitive. If `--no-sensitive` is rejected, drop that flag for the two plain vars.

- [ ] **Step 2: Delete the secret file now.** `$D` has no NTFS permission protection, so do not leave it there. Keep the non-secret files (`ids.env`, `email-app.snapshot.json`, the restore helpers) for Rollback until Task 14.

```bash
D="$HOME/.pai222" && rm -f "$D/cf.env" && ls -A "$D" && grep -rl "CF_CLIENT_SECRET\|OPENSEO_PUBLIC_API_KEYS" "$D" | wc -l
```
Expected: the listing shows only `email-app.snapshot.json  find_email_app.py  ids.env  restore-email-app.sh  restore_email_app.py`, then `0`. The CF client secret now lives only in Vercel (Sensitive). If it is ever needed again, rotate the token instead: `POST …/access/service_tokens/{id}/rotate`.

---

### Task 13: Push and clean up the worktree

**Files:** none

- [ ] **Step 1: Push `main`** (the two pending commits `9dbaa54`, `43e9ae3` plus the PAI-222 commits) **and the branch**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo && git push origin main && git push origin PAI-222/public-summary-api && git status -sb
```
Expected: both pushes succeed; `## main...origin/main` with no ahead/behind.

- [ ] **Step 2: Remove the worktree** (the branch stays on origin as a record)

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo && git worktree remove ../open-seo-PAI-222 && git branch -d PAI-222/public-summary-api && git worktree list
```
Expected: only the main checkout is listed.

---

### Task 14: Update the tickets

**Files:**
- Modify: `C:\Users\Brizzle\vault\7-Systems\tickets\PAI-222-openseo-public-summary-api.md`
- Modify: `C:\Users\Brizzle\vault\7-Systems\tickets\CLIENT-SBLV-142-admin-v2-wire-live-data-sources.md` (log line only; find the exact filename with `ls ~/vault/7-Systems/tickets/ | grep CLIENT-SBLV-142`)

- [ ] **Step 1: PAI-222.** Set `status: done` and remove `waiting_on: claude` (or set it to `none`). Append to `## Log`, filling in the ids and dates recorded in Tasks 10-11. No secrets:

```markdown
- 2026-09-28 — Shipped. `main` @ <sha> (pushed; branch `PAI-222/public-summary-api`). Route `src/routes/api/public/v1/projects/$projectId/summary.ts` → `src/server/features/public-api/*` (bearer key bound to project via `OPENSEO_PUBLIC_API_KEYS` in `.env.selfhost`; `Promise.allSettled` sections; no DataForSEO spend). Deployed via Git Bash manual `alchemy deploy` (cmd.exe NODE_OPTIONS papercut still open). Access ids (from `~/.pai222/ids.env`): service token `sblv-admin-openseo` CF_SVC_TOKEN_ID=<id> (expires <expires_at> — rotate before then), ACCESS_POLICY_ID=<id> (reusable, non_identity), ACCESS_APP_ID=<id> on `seo.bryanrivera.ai/api/public`; email app <email_app_id> destinations <kept|restored after deploy>. Rollback: plan §Rollback (needs these ids). Key accepted via `Authorization: Bearer` or `X-OpenSEO-Key`. Live matrix 1-7 passed (<note any section error codes>). SBLV Vercel (production+preview): OPENSEO_API_KEY, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET (Sensitive), OPENSEO_API_URL, OPENSEO_PROJECT_ID.
- Semantics for the consumer: range = N inclusive days ending today−3 UTC (GSC+GA4 share it); ga4 totals/daily = Organic Search only, ga4.sources = all channels top 10; rankings.keywords ≤100 sorted by position, position/previousPosition/url may be null; audit.status "none" when never run, issuesBySeverity = affected pages summed per severity; backlinks = stored snapshot only (zeros + capturedAt null when none); 422 body {error:"invalid_range"}; 500 {error:"internal_error"}.
```

- [ ] **Step 2: CLIENT-SBLV-142.** Append one log line: `- 2026-09-28 — PAI-222 live: OpenSEO summary endpoint + CF Access service token; SBLV Vercel env set (production+preview). Semantics notes in PAI-222 log.`

- [ ] **Step 3: If `~/vault` is a git repo, commit only those two files**

```bash
cd /c/Users/Brizzle/vault && git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git add 7-Systems/tickets/PAI-222-openseo-public-summary-api.md "7-Systems/tickets/$(ls 7-Systems/tickets | grep '^CLIENT-SBLV-142')" && git commit -m "$(cat <<'EOF'
tickets: PAI-222 shipped; CLIENT-SBLV-142 env ready

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)" || echo "vault not a git repo or nothing to commit"
```

- [ ] **Step 4: Remove the working dir** (only after the ids are in the ticket log)

```bash
grep -c "ACCESS_APP_ID=" /c/Users/Brizzle/vault/7-Systems/tickets/PAI-222-openseo-public-summary-api.md && rm -rf "$HOME/.pai222" && ls -d "$HOME/.pai222" 2>/dev/null | wc -l
```
Expected: `1`, then `0`. The email-app snapshot is gone after this. A later rollback restores destinations by hand-listing them (`open-seo-selfhost.bryan-rivera-bfd.workers.dev`, `seo.bryanrivera.ai`), as noted in Rollback R3.

---

## Rollback

Use this if live verification fails in a way that cannot be fixed forward, or if the endpoint must be withdrawn. Resource ids come from `~/.pai222/ids.env` while it exists, otherwise from the PAI-222 ticket log. Run the steps in order: the app references the policy, and the policy references the token.

- [ ] **R1: Delete the path app, then the policy, then the service token**

```bash
cd /c/Users/Brizzle/projects/tools/_active/open-seo && set -a && . ./.env.selfhost && { [ -f "$HOME/.pai222/ids.env" ] && . "$HOME/.pai222/ids.env"; true; } && set +a && BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access" && \
for pair in "apps:${ACCESS_APP_ID:-}" "policies:${ACCESS_POLICY_ID:-}" "service_tokens:${CF_SVC_TOKEN_ID:-}"; do kind=${pair%%:*}; id=${pair#*:}; [ -z "$id" ] && { echo "$kind: no id recorded — skip (check the ticket log)"; continue; }; curl -s -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE/$kind/$id" | python -c "import json,sys; d=json.load(sys.stdin); print('$kind', '$id', 'deleted', d.get('success'), d.get('errors'))"; done
```
If `ids.env` is gone, export the three ids from the ticket log first (`ACCESS_APP_ID=… ACCESS_POLICY_ID=… CF_SVC_TOKEN_ID=…` before the command). Expected: three `deleted True []` lines. Afterwards, `seo.bryanrivera.ai/api/public/*` falls back to the email app. The endpoint is then unreachable for the service token, and a request without credentials gets 401 at the Access edge.

- [ ] **R2: Restore the email app from the saved snapshot** (skip if Task 9 Step 4 reported intact destinations and nothing changed since)

```bash
FORCE=1 bash "$HOME/.pai222/restore-email-app.sh"
```
Expected: `RESTORED True [] [...]`, with the snapshot's destinations.

- [ ] **R3: If `~/.pai222` no longer exists**, restore the destinations in the Zero Trust dashboard (Access → Applications → "open-seo selfhost" → Overview → Public hostnames): `open-seo-selfhost.bryan-rivera-bfd.workers.dev` and `seo.bryanrivera.ai`, with policy "open-seo selfhost self-host users". Bryan does this dashboard step.

- [ ] **R4: Code and consumer.** Revert the PAI-222 commits on `main`, `git revert --no-edit <oldest>^..<newest>`, and push. Remove `OPENSEO_PUBLIC_API_KEYS` from `.env.selfhost` and redeploy (Task 9 Step 3, then Step 4). Remove the SBLV vars in `socialboothlv-site` with `vercel env rm <NAME> production --yes` and `vercel env rm <NAME> preview --yes` for `OPENSEO_API_KEY`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `OPENSEO_API_URL`, `OPENSEO_PROJECT_ID`.

- [ ] **R5: Log it.** Append a PAI-222 log line listing every deleted id, and set `status: in-progress`, `waiting_on: claude` (or `blocked` with the reason).

---

## Open risks

1. **Alchemy vs. the hand-added `seo.bryanrivera.ai` Access destination.** Every `deploy:selfhost` re-provisions the email app from `domain` only. Task 9 Steps 2/4 detect a dropped destination and restore it. The durable fix is a follow-up: pass `SELFHOST_DOMAINS` into `emailAccessGate`.
2. **Access and the `Authorization: Bearer` header.** Access apps with managed OAuth answer `WWW-Authenticate: Bearer realm="OAuth"`. The new path app has no OAuth, and service-token auth uses the `CF-Access-Client-*` headers, so the Bearer header should pass through. If Access does strip or reject it, the contract already covers that case: the key is also accepted in `X-OpenSEO-Key`, which the SBLV consumer always sends alongside Bearer. Task 11 checks 5x/5z prove that path, so no contract change or coordination would be needed. Only record which header carried the request.
3. **Service token expiry.** The token lasts 8760h (1 year). Log `expires_at` and rotate before it.
4. **GA4 semantics.** Organic-only totals plus all-channel sources is a choice this plan makes. Confirm it with the consumer.
5. **The API token may lack Access write scopes** (Task 10 Step 1 stop path).
