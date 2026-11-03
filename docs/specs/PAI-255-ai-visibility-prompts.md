# PAI-255: AI visibility buyer prompts (fork)

Status: spec, 2026-11-02. Extends PAI-217 (`ai_visibility_configs` and `ai_visibility_snapshots`). Admin consumer: socialboothlv-site `docs/specs/PAI-255-buyer-prompts.md`.

## Why

PAI-217 tracks LLM Mentions, DataForSEO's dataset of prompts that already mention the brand. For SBLV that dataset matched prompts unrelated to corporate buyers ("alternatives to balloons"), and the November numbers were identical to October's, so it hadn't refreshed. A live ChatGPT test of "best photo booth company for a corporate event in Las Vegas" put SBLV at #1. That is the result worth tracking. This feature stores a short list of buyer prompts per project and asks each AI platform those prompts once a month.

## Plan

1. Spec (this file). It is the first commit.
2. Schema: two tables in the existing `ai-visibility.schema.ts` files (D1 and PG), plus a parity test entry. The migration goes in its own final commit.
3. DataForSEO: two new live fetchers (`chat_gpt/llm_scraper`, `serp/google/ai_mode`). Perplexity reuses `fetchLlmResponse`.
4. A pure answer parser (`promptAnswers.ts`) that turns each platform response into one normalized answer and then one result row. Fixture tests use real responses from 2026-11-02.
5. Service and repository: `AiVisibilityPromptService` (add, list, remove, run, results) and `AiVisibilityPromptRepository`.
6. Scheduler: a prompt phase inside `runScheduledAiVisibilityChecks`. No new cron expression.
7. MCP: five tools.
8. Public summary: `aiVisibility.prompts`, built in `public-api/sections/aiVisibilityPrompts.ts`.
9. Seed SQL for the 8 SBLV prompts, `scripts/seed-sblv-buyer-prompts.sql`. It is not run.

## Endpoints chosen (cheapest reliable per platform)

| Platform key     | DataForSEO endpoint                                                                                                                                                 | Price                        | Observed 2026-11-02 (8 prompts) | Why                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat_gpt`       | `POST /v3/ai_optimization/chat_gpt/llm_scraper/live/advanced`                                                                                                       | $0.004 per result (live)     | $0.004 each, 14–105 s           | Has its own 150 s abort (the shared DataForSEO budget is 60 s) and no 5xx replay, because an aborted live call is still billed. This is what a buyer sees on chatgpt.com, with ordered `brand_entities`, `sources` and inline links. `llm_responses` on gpt-5 costs $0.0006 plus tokens (≥ $0.01 with web search) and returns the API model, not the consumer product. |
| `google_ai_mode` | `POST /v3/serp/google/ai_mode/live/advanced`                                                                                                                        | $0.004 per SERP (live)       | $0.004 each, 8–21 s             | AI Mode always answers. An AI Overview appears only on some organic SERPs and costs extra to expand.                                                                                                                                                                                                                                                                   |
| `perplexity`     | `POST /v3/ai_optimization/perplexity/llm_responses/live`, `model_name: "sonar"`, `web_search: true`, `web_search_country_iso_code: "US"`, `max_output_tokens: 1024` | $0.0006 per task plus tokens | $0.0058–0.0061 each             | There is no Perplexity scraper. `sonar` is the cheapest Sonar model. The answer carries `[n]` citation markers that point into `annotations`.                                                                                                                                                                                                                          |

Market: US (`location_code` 2840, `en`), the same as PAI-217. The prompts name Las Vegas themselves.

**Standard queue: not used.** ChatGPT and AI Mode cost $0.0012 per result in the standard queue (up to 45 minutes), which saves $0.0028 per call. For SBLV that is $0.045 a month. The queue would need a post phase, a stored task id and a collect phase on a later tick. Live calls finish inside one tick and can't strand a prepaid task, so they are the reliable choice at this volume. Revisit above roughly 200 prompts per month across all projects (about $0.56/mo saved).

## Cost per month

| Scope                              | ChatGPT | AI Mode | Perplexity | Total       |
| ---------------------------------- | ------- | ------- | ---------- | ----------- |
| Per prompt (3 platforms), observed | $0.004  | $0.004  | ~$0.006    | **~$0.014** |
| SBLV, 8 prompts                    | $0.032  | $0.032  | $0.048     | **~$0.11**  |
| All 10 trackers at 8 prompts each  |         |         |            | ~$1.12      |

Estimates used for timed-out calls and tool descriptions: $0.004, $0.004 and $0.007 (sonar at the 1,024-token output cap), so $0.015 per prompt.

**Worst-case bound per project per month: $0.45.** Every run (cron, retry, "run now", `force`) counts an attempt, and a platform gets at most 3 attempts a month. At most 10 distinct prompts can run per project per month, however often prompts are removed and added. So the most that can be billed is 10 prompts × 3 attempts × $0.015 = $0.45, even if every call times out or fails after billing. A separate hard stop refuses or defers runs once the month's recorded spend reaches **$1.00** (`MONTHLY_PROMPT_COST_CAP_USD`), which is above the bound and only matters if the prices change.

Fixture run 2026-11-02: 23 calls cost $0.1077 (7 ChatGPT, 8 AI Mode, 8 Perplexity). ChatGPT prompt 1 was reused from SBLV-188 (`$0.004`).

## Data model

Both tables live in `src/db/ai-visibility.schema.ts` and `src/db/pg/ai-visibility.schema.ts`, beside the PAI-217 tables, so the schema barrels only gain two export names.

### `ai_visibility_prompts`

| Column           | Type                                                                   | Notes                                                                                     |
| ---------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `id`             | text PK                                                                | UUID                                                                                      |
| `project_id`     | text, FK `projects.id`, on delete cascade                              |                                                                                           |
| `prompt`         | text, not null                                                         | Trimmed, inner whitespace collapsed, 3–300 characters                                     |
| `platforms_json` | text, not null, default `'["chat_gpt","google_ai_mode","perplexity"]'` | Array of platform keys. Zod-validated on read; unknown keys are dropped.                  |
| `is_active`      | boolean, not null, default true                                        | Remove = deactivate. History is kept, and adding the same text again reactivates the row. |
| `next_run_at`    | text, nullable                                                         | The cron runs a prompt when `next_run_at <= now`                                          |
| `last_run_at`    | text, nullable                                                         |                                                                                           |
| `last_error`     | text, nullable                                                         |                                                                                           |
| `created_at`     | text, default now                                                      |                                                                                           |

Indexes: unique `(project_id, prompt)` and `(is_active, next_run_at)`.

Limits: 10 active prompts per project (`add` rejects more), and 10 distinct prompts run per project per calendar month (a prompt over that waits for next month). Runs go two prompts at a time (6 DataForSEO calls), the Workers connection limit.

### `ai_visibility_prompt_results`

One row per (prompt, platform, run). A run is the UTC calendar month (`period`, `YYYY-MM`), the same as PAI-217 snapshots. A re-run in the same month replaces the row. `cost_usd` and `attempts` accumulate.

| Column             | Type                                                   | Notes                                                                                                                       |
| ------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `id`               | integer PK (serial in PG)                              |                                                                                                                             |
| `prompt_id`        | text, FK `ai_visibility_prompts.id`, on delete cascade |                                                                                                                             |
| `platform`         | text enum `chat_gpt`, `google_ai_mode`, `perplexity`   |                                                                                                                             |
| `period`           | text `YYYY-MM`                                         | The run                                                                                                                     |
| `status`           | text enum `ok`, `error`                                |                                                                                                                             |
| `mentioned`        | boolean, nullable                                      | Null on error                                                                                                               |
| `position`         | integer, nullable                                      | 1-based. Null when not mentioned.                                                                                           |
| `brands_named`     | integer, nullable                                      | How many distinct brands the answer named (the denominator for "#2 of 6")                                                   |
| `cited_url`        | text, nullable                                         | The first cited or linked URL on the target's domain                                                                        |
| `cited_urls_json`  | text, default `'[]'`                                   | Every cited source URL, deduped, in order, at most 20                                                                       |
| `competitors_json` | text, default `'[]'`                                   | `[{domain, name, position}]`, tracked competitors the answer named, in order                                                |
| `excerpt`          | text, nullable                                         | About 400 characters around the first target mention, or the answer's opening when not mentioned. Markdown images stripped. |
| `model`            | text, nullable                                         | The `model` / `model_name` DataForSEO reports (for example `gpt-6`, `sonar`)                                                |
| `error`            | text, nullable                                         |                                                                                                                             |
| `attempts`         | integer, default 1                                     | Incremented on each upsert in the same period                                                                               |
| `cost_usd`         | real, default 0                                        | Accumulates                                                                                                                 |
| `captured_at`      | text, default now                                      |                                                                                                                             |

Indexes: unique `(prompt_id, platform, period)`.

The JSON columns hold per-answer snapshot values, the same as PAI-217's `share_of_voice_json`. They are not relations anyone joins on.

Migrations: D1 `drizzle/0046_ai_visibility_prompts.sql` and PG `drizzle-pg/0024_ai_visibility_prompts.sql`, both generated by `drizzle-kit generate`. They are additive (two `CREATE TABLE`s and their indexes) and come last. The coordinator renumbers them if another wave branch takes 0046 first.

## Answer parsing (how "mentioned", "position" and "cited" are decided)

Each platform response is first normalized into:

```ts
type NormalizedAnswer = {
  text: string; // answer markdown, images removed
  links: { url: string; offset: number }[]; // inline links and resolved [n] markers, in text order
  sources: string[]; // cited source URLs, in order
  entities: string[]; // platform-tagged brand names, in order (ChatGPT only)
  model: string | null;
};
```

- **ChatGPT:** `markdown`, inline `[text](url)` links, `sources[].url`, and `brand_entities[].markdown`, falling back to `.title`. `search_results` are pages the model fetched but did not show, so they are ignored.
- **AI Mode:** `items[type=ai_overview].markdown` (its `[Website](url)` and `[[n]](url)` links), plus `references[].url` and `items[].references/links`. Hosts on `google.*` (Maps directions) are dropped.
- **Perplexity:** `items[].sections[].text`. Each `[n]` marker resolves to `annotations[n-1].url` at that offset. `sources` are the annotations the text references, or all annotations when the text has no markers.

Then the normalized answer is analyzed against the brands:

- **Target:** the tracker's `target` domain. Its names are the domain stem (`socialboothlv`).
- **Competitors:** `project_competitors` rows (`domain`, `name`). The stored `name` is matched as words. The domain stem is matched only as a single word ("BoothNV"), by a link to the domain, or by an exact ChatGPT entity name, so a keyword domain such as `lasvegasphotobooth.com` never matches the phrase "Las Vegas photo booth". A stored name that is just the domain is treated as the stem.
- **Stems:** the registrable label of a host: `m.yelp.com` → `yelp`, `en.wikipedia.org` → `wikipedia`, `foo.co.uk` → `foo`.
- **Name match:** the text is lowercased and split into alphanumeric words. A brand is named at the first window of 1–6 consecutive words whose concatenation equals one of its compact names. "Social Booth LV", "SocialBoothLV" and "socialboothlv.com" all match `socialboothlv`. "LV Photography" does **not** match `lvphoto`, and "The Social Booth Co" does not match `socialboothlv`. Compact names shorter than 4 characters are ignored.
- **Link match:** a link whose host (without `www.`) equals the brand's domain or is a subdomain of it.
- **Other businesses:** ChatGPT entities that are neither target nor competitor, and links to hosts that are not on the aggregator list (`yelp`, `thumbtack`, `theknot`, `weddingwire`, `eventective`, `bark`, `partyslate`, `gigsalad`, `photoboothlocator`, `photoboothrentalfinder`, `facebook`, `instagram`, `linkedin`, `youtube`, `tiktok`, `reddit`, `wikipedia`, `tripadvisor`, `google`, `bing`, `apple`, `openai`, `zola`, `pinterest`, `bbb`, `nextdoor`, `x`, `twitter`; matched on the registrable domain), count as untracked brands. When the platform tags entities (ChatGPT), untracked brands come from the entities only, and untracked links are ignored so that "Milestone Media" and `milestonenj.com` count once.
- **mentioned:** the target is named or linked anywhere in the answer text.
- **position:** the 1-based rank of the target among the brands we can name (tracked brands and ChatGPT entities), ordered by first offset. A bare linked host (AI Mode, Perplexity) is often an event site, a blog or a chain's page in another city, so it counts in `brands_named` but never pushes the position down.
- **brands_named:** every distinct brand, linked hosts included.
- **cited_url:** the first link or source on the target's domain, with `utm_*` stripped. It is set even when `mentioned` is false (cited but not named).
- **competitors:** tracked competitors that were named or linked, with their positions.

Known limits, also stated in the MCP tool description: competitor matching needs the name the AI actually uses. "KL360" will not match a competitor stored as "KL 360 Photo Booth" unless its domain stem matches. Edit the competitor's `name` in project context to fix it.

## Scheduling and run guards

The prompt phase runs inside `runScheduledAiVisibilityChecks`, on the existing `*/5` cron. It has no new cron expression. The cron and `run_ai_visibility_prompts` use one runner (`promptRuns.ts`), so every run passes the same guards.

- **Phase gate:** it runs only on ticks where the mentions phase found no due tracker, and only when less than 60 s of the tick has gone (the handler passes its start time; the rank loop shares the tick's subrequest budget, which a Worker can't read). Otherwise due prompts wait for the next tick.
- **Due prompts:** `is_active` and `next_run_at <= now`, with the project's tracker active and `monthly`, and the project not archived. Oldest first, 2 per tick. Eight prompts drain in 4 ticks, about 20 minutes.
- **Lease:** compare-and-set `next_run_at` from the value read to now + 15 min. A concurrent run (another tick or a second "run now") fails the swap and skips the prompt as `busy`. A run that dies mid-way is due again after 15 minutes.
- **Monthly limits (checked before the lease):** spend this month ≥ $1.00 → defer (`cost_cap`); a prompt that hasn't run this month while 10 others already have → defer (`monthly_prompt_limit`). Deferred prompts move to next month.
- **Run:** ask each configured platform that has no `ok` row this month (all of them with `force`) and fewer than 3 attempts this month. Every call, success or failure, adds an attempt. A failure never replaces an `ok` row; it only adds its cost. A timed-out call is recorded at the estimated price above, since DataForSEO bills it without returning a cost.
- **Finish:** `next_run_at = now + 6 h` if a platform failed and has an attempt left, otherwise the next 1st at 06:00 UTC. If the whole run throws, every open platform gets an error row (an attempt), so the same 3-attempt cap stops retries.
- **New and re-added prompts:** `add` sets `next_run_at = now`. Re-adding a removed prompt keeps its result rows, so its attempts this month still count. The seed SQL only reactivates on conflict and leaves `next_run_at` alone.

## API contract: `aiVisibility.prompts`

Additive key on the existing `aiVisibility` object. It is built in `src/server/features/public-api/sections/aiVisibilityPrompts.ts` and never throws: a failure becomes `{ "error": "<code>" }` for this key only and leaves the rest of `aiVisibility` intact. A summary from a fork without this feature has no `prompts` key.

```ts
type PromptPlatform = "chat_gpt" | "google_ai_mode" | "perplexity";

type PromptRun = {
  period: string; // "YYYY-MM"
  capturedAt: string | null; // ISO
  status: "ok" | "error";
  mentioned: boolean | null; // null when status = "error"
  position: number | null; // 1-based; null when not mentioned
  brandsNamed: number | null;
  citedUrl: string | null; // this site's first cited page
  competitors: {
    domain: string;
    name: string | null;
    position: number | null;
  }[];
  excerpt: string | null;
  error: string | null;
};

type PromptPlatformResult = {
  platform: PromptPlatform;
  latest: PromptRun;
  previous: Omit<PromptRun, "excerpt" | "competitors"> | null; // the run before latest
};

type AiVisibilityPrompts = {
  // Whether the cron runs the prompts: only for an active monthly tracker.
  schedule: "monthly" | "manual" | "paused" | "none";
  lastRunAt: string | null; // newest captured_at across active prompts
  nextRunAt: string | null; // earliest next_run_at across active prompts
  items: {
    id: string;
    prompt: string;
    platforms: PromptPlatform[]; // configured
    createdAt: string | null;
    results: PromptPlatformResult[]; // only platforms with at least one run; order chat_gpt, google_ai_mode, perplexity
  }[]; // active prompts, oldest first; [] when none
};
// summary.aiVisibility.prompts: AiVisibilityPrompts | { error: string }
```

Example (SBLV, after the first run):

```json
"prompts": {
  "schedule": "monthly",
  "lastRunAt": "2026-11-03T07:30:12.000Z",
  "nextRunAt": "2026-12-01T06:00:00.000Z",
  "items": [
    {
      "id": "6c1d…",
      "prompt": "best photo booth company for a corporate event in Las Vegas",
      "platforms": ["chat_gpt", "google_ai_mode", "perplexity"],
      "createdAt": "2026-11-03T07:20:00.000Z",
      "results": [
        {
          "platform": "chat_gpt",
          "latest": {
            "period": "2026-11", "capturedAt": "2026-11-03T07:30:12.000Z", "status": "ok",
            "mentioned": true, "position": 1, "brandsNamed": 5,
            "citedUrl": "https://socialboothlv.com/corporate-events",
            "competitors": [{ "domain": "boothmeuplv.com", "name": "Booth Me Up LV", "position": 2 },
                            { "domain": "lvphoto.co", "name": "LV Photo", "position": 5 }],
            "excerpt": "For a **corporate event in Las Vegas**, I would put **Social Booth LV, BoothMeUp LV, and Milestone Media** at the top…",
            "error": null
          },
          "previous": null
        },
        {
          "platform": "perplexity",
          "latest": { "period": "2026-11", "capturedAt": "…", "status": "ok", "mentioned": false, "position": null,
                      "brandsNamed": 5, "citedUrl": null, "competitors": [], "excerpt": "**Milestone Media** is the strongest…", "error": null },
          "previous": null
        }
      ]
    }
  ]
}
```

## MCP tools

| Tool                               | Spends                                                                               | Input                                                                                 | Output                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `add_ai_visibility_prompts`        | Schedules about $0.015 per new prompt, which the cron spends within about 10 minutes | `projectId`, `prompts: string[1..10]`, `platforms?: PromptPlatform[]` (default all 3) | `{ added, reactivated, unchanged, prompts[] }`                 |
| `list_ai_visibility_prompts`       | No                                                                                   | `projectId`, `includeInactive?`                                                       | `{ prompts[] }` with schedule fields                           |
| `remove_ai_visibility_prompts`     | No                                                                                   | `projectId`, `promptIds: string[1..20]`                                               | `{ removed }` (deactivated, history kept)                      |
| `run_ai_visibility_prompts`        | Yes, ~$0.015 per prompt; refused at the $1.00 monthly cap                            | `projectId`, `promptIds?` (default all active), `force?`                              | `{ period, costUsd, outcomes[], skipped[{promptId, reason}] }` |
| `get_ai_visibility_prompt_results` | No                                                                                   | `projectId`                                                                           | The `AiVisibilityPrompts` object above, plus a text table      |

`run` goes through the guards above (lease, 3 attempts per platform a month, 10 prompts a month, $1.00 cap), two prompts at a time. It skips platforms that already have an `ok` row this month unless `force` is set, and refuses when the project has no AI visibility tracker or the month is at the cap.

## UI (fork app)

Out of scope here. The admin is the consumer. `AvailableTools.tsx` lists the five tools.

## Tests

- `promptAnswers.test.ts`: real fixtures (trimmed) for each platform. ChatGPT prompt 1 gives SBLV #1 of 5, cited `/corporate-events`, BoothMeUp #2. AI Mode prompt 1 gives SBLV #1 of 4 (the Shutterbox link counts in brands named, not position), with a Google Maps link ignored. Perplexity prompt 8: zola.com and america.imexevents.com don't push SBLV down. Registrable-domain stems. A keyword-domain competitor (`lasvegasphotobooth.com`) never matches the phrase, only its link; `photoboothrentallasvegasnv.com` matches by link or by its stored name. Name-window edge cases and `utm` stripping.
- `AiVisibilityPromptService.test.ts` (real SQL over the shipped migrations): add normalizes, dedupes, reactivates and caps at 10; run writes ok and error rows; a timed-out call is billed at its estimate; 3 attempts per platform a month, force and re-adding included; concurrent "run now" calls run a prompt once; at most two prompts in flight; refused at the $1.00 cap; remove + add can't pass 10 prompts a month; results pick latest and previous per platform plus `schedule`.
- `scheduledPromptChecks.test.ts`: the prompt phase waits while a tracker is due; runs and reschedules monthly; retries after 6 h up to 3 attempts; waits when the tick is past 60 s; a run that throws counts an attempt on every open platform; manual trackers are skipped.
- `ai-prompts.test.ts`: the ChatGPT fetcher passes its own 150 s signal and no 5xx replay; AI Mode keeps the default.
- `aiVisibilityPrompts.test.ts` (summary section): shape, `{error}` isolation.
- MCP tool tests; `schema-parity.test.ts` covers both tables.

## Rollout

1. The coordinator merges the branch (migration last; renumber if needed) and deploys with the chained alchemy command from `reference_openseo_setup.md`.
2. Apply the D1 migration `0046_ai_visibility_prompts.sql`.
3. Seed SBLV: review `scripts/seed-sblv-buyer-prompts.sql`, then run it through the D1 API. It inserts 8 prompts with `next_run_at = now`; re-running it only reactivates them. Alternatively, call `add_ai_visibility_prompts` with the same 8 prompts.
4. First run: the `*/5` cron baselines them within about 20 minutes (4 ticks). Or call `run_ai_visibility_prompts` for an immediate run of about $0.11 (bounded at $0.45 a month per project).
5. Verify `GET /api/public/v1/projects/c65ed7c9-…/summary` returns `aiVisibility.prompts.items` with 8 entries and up to 3 results each. Log `SUM(cost_usd)` in PAI-255.
6. Monthly from 2026-12-01 06:00 UTC, after the mentions phase drains.
