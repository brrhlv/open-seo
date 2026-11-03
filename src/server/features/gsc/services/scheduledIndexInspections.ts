import {
  UrlInspectionRepository,
  type DueKeyPage,
  type InspectionResultFields,
} from "@/server/features/gsc/repositories/UrlInspectionRepository";
import { GscService } from "@/server/features/gsc/services/GscService";
import type { UrlInspectionResult } from "@/server/lib/gscClient";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";

// CLIENT-SBLV-194: refresh the stored URL Inspection of project key pages, at
// most once a day per URL (Search Console allows 2,000 inspections a day per
// property). Runs on the */5 tick beside rank checks and AI visibility, which
// share Workers Free's 50-subrequest cap, so a tick inspects a few URLs and
// the rest stay due for the next tick.
const INSPECTIONS_PER_TICK = 8;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// A failed check (rate limit, Google 5xx, token) retries after an hour.
const RETRY_MS = 60 * MINUTE_MS;
// A tick holds its pages this long, so an overlapping tick skips them; a
// tick that dies leaves them due again once it lapses.
const LEASE_MS = 15 * MINUTE_MS;
// Same wall-clock guard as the sibling schedulers.
const TICK_DEADLINE_MS = 3 * MINUTE_MS;
const OUTSIDE_PROPERTY = "URL is outside the Search Console property";

/** A host without a leading www, lowercased. */
const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, "");

/**
 * The URL to send to GSC for a key page, or null when it is outside the
 * property. Domain properties (`sc-domain:example.com`) take the stored URL
 * as is. URL-prefix properties take its path and query on the property's
 * origin, because key pages are stored without `www`.
 */
function inspectionUrlFor(keyPageUrl: string, siteUrl: string): string | null {
  let page: URL;
  try {
    page = new URL(keyPageUrl);
  } catch {
    return null;
  }
  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length).toLowerCase();
    const host = page.hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`) ? page.href : null;
  }
  let prefix: URL;
  try {
    prefix = new URL(siteUrl);
  } catch {
    return null;
  }
  if (bareHost(page.hostname) !== bareHost(prefix.hostname)) return null;
  const rebased = new URL(`${page.pathname}${page.search}`, prefix.origin).href;
  return rebased.startsWith(siteUrl) || `${rebased}/` === siteUrl
    ? rebased
    : null;
}

function resultFields(
  result: UrlInspectionResult,
): InspectionResultFields | null {
  const status = result.indexStatusResult;
  if (!status) return null;
  return {
    verdict: status.verdict ?? null,
    coverageState: status.coverageState ?? null,
    indexingState: status.indexingState ?? null,
    robotsTxtState: status.robotsTxtState ?? null,
    pageFetchState: status.pageFetchState ?? null,
    googleCanonical: status.googleCanonical ?? null,
    userCanonical: status.userCanonical ?? null,
    lastCrawlTime: status.lastCrawlTime ?? null,
    crawledAs: status.crawledAs ?? null,
  };
}

type Target = { projectId: string; url: string; inspectedUrl: string };

/** Inspect one project's claimed pages; every page gets a success or a failure. */
async function inspectProject(
  projectId: string,
  targets: Target[],
  now: Date,
): Promise<{ inspected: number; failed: number }> {
  const stamp = now.toISOString();
  const nextDay = new Date(now.getTime() + DAY_MS).toISOString();
  const retry = new Date(now.getTime() + RETRY_MS).toISOString();
  let failed = 0;
  const fail = (target: Target, error: string) => {
    failed++;
    return UrlInspectionRepository.recordFailure({
      ...target,
      error,
      now: stamp,
      nextCheckAt: retry,
    });
  };

  let results: Map<
    string,
    { result: UrlInspectionResult | null; error?: string }
  >;
  try {
    const response = await GscService.inspectUrls({
      projectId,
      urls: targets.map((target) => target.inspectedUrl),
    });
    results = new Map(response.results.map((r) => [r.url, r]));
  } catch (error) {
    // Token or grant failure for the whole project.
    const message =
      error instanceof Error ? error.message : "Inspection failed";
    for (const target of targets) await fail(target, message);
    return { inspected: targets.length, failed };
  }
  for (const target of targets) {
    const outcome = results.get(target.inspectedUrl);
    const fields = outcome?.result ? resultFields(outcome.result) : null;
    if (fields) {
      await UrlInspectionRepository.recordSuccess({
        ...target,
        fields,
        now: stamp,
        nextCheckAt: nextDay,
      });
    } else {
      await fail(
        target,
        outcome?.error ?? "Search Console returned no inspection result",
      );
    }
  }
  return { inspected: targets.length, failed };
}

/** Cron body: inspect up to INSPECTIONS_PER_TICK due key pages. Self-host only. */
export async function runScheduledIndexInspections(now = new Date()) {
  if (await isHostedServerAuthMode()) return;
  const deadline = Date.now() + TICK_DEADLINE_MS;
  const stamp = now.toISOString();
  const due = await UrlInspectionRepository.listDueKeyPages(
    stamp,
    INSPECTIONS_PER_TICK,
  );
  if (due.length === 0) return;

  const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
  const nextDay = new Date(now.getTime() + DAY_MS).toISOString();
  // Claimed pages per project, in the due order (most stale first).
  const byProject = new Map<string, Target[]>();
  let skipped = 0;
  let outside = 0;
  for (const row of due) {
    const inspectedUrl = inspectionUrlFor(row.url, row.siteUrl);
    const claimed = await UrlInspectionRepository.claim(row, {
      inspectedUrl: inspectedUrl ?? row.url,
      now: stamp,
      leaseUntil,
    });
    if (!claimed) {
      skipped++;
      continue;
    }
    if (!inspectedUrl) {
      outside++;
      await UrlInspectionRepository.recordFailure({
        ...pageOf(row),
        inspectedUrl: row.url,
        error: OUTSIDE_PROPERTY,
        now: stamp,
        nextCheckAt: nextDay,
      });
      continue;
    }
    const list = byProject.get(row.projectId) ?? [];
    list.push({ ...pageOf(row), inspectedUrl });
    byProject.set(row.projectId, list);
  }

  let inspected = 0;
  let failed = 0;
  let stoppedByDeadline = false;
  for (const [projectId, targets] of byProject) {
    // Unprocessed pages keep their lease and come due again when it lapses.
    if (Date.now() >= deadline) {
      stoppedByDeadline = true;
      break;
    }
    const result = await inspectProject(projectId, targets, now);
    inspected += result.inspected;
    failed += result.failed;
  }
  (failed > 0 ? console.error : console.log)({
    event: "index_inspection_tick",
    due: due.length,
    inspected,
    failed,
    outside,
    skipped,
    stoppedByDeadline,
  });
}

const pageOf = (row: DueKeyPage) => ({
  projectId: row.projectId,
  url: row.url,
});
