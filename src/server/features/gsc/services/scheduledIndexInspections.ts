import { groupBy } from "remeda";
import {
  UrlInspectionRepository,
  type UrlInspectionWrite,
} from "@/server/features/gsc/repositories/UrlInspectionRepository";
import { GscService } from "@/server/features/gsc/services/GscService";
import type { UrlInspectionResult } from "@/server/lib/gscClient";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";

// CLIENT-SBLV-194: refresh the stored URL Inspection of project key pages, at
// most once a day per URL (Search Console allows 2,000 inspections a day per
// property). Runs on the */5 tick beside rank checks and AI visibility, which
// share Workers Free's 50-subrequest cap, so a tick inspects a few URLs and
// the rest stay due for the next tick.
export const INSPECTIONS_PER_TICK = 8;
const DAY_MS = 24 * 60 * 60_000;

/** A host without a leading www, lowercased. */
const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, "");

/**
 * The URL to send to GSC for a key page, or null when it is outside the
 * property. Domain properties (`sc-domain:example.com`) take the stored URL
 * as is. URL-prefix properties take its path and query on the property's
 * origin, because key pages are stored without `www`.
 */
export function inspectionUrlFor(
  keyPageUrl: string,
  siteUrl: string,
): string | null {
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

const emptyResult = {
  verdict: null,
  coverageState: null,
  indexingState: null,
  robotsTxtState: null,
  pageFetchState: null,
  googleCanonical: null,
  userCanonical: null,
  lastCrawlTime: null,
  crawledAs: null,
};

function toWrite(input: {
  projectId: string;
  url: string;
  inspectedUrl: string;
  inspectedAt: string;
  result?: UrlInspectionResult | null;
  error?: string;
}): UrlInspectionWrite {
  const status = input.result?.indexStatusResult;
  return {
    projectId: input.projectId,
    url: input.url,
    inspectedUrl: input.inspectedUrl,
    inspectedAt: input.inspectedAt,
    ...emptyResult,
    ...(status
      ? {
          verdict: status.verdict ?? null,
          coverageState: status.coverageState ?? null,
          indexingState: status.indexingState ?? null,
          robotsTxtState: status.robotsTxtState ?? null,
          pageFetchState: status.pageFetchState ?? null,
          googleCanonical: status.googleCanonical ?? null,
          userCanonical: status.userCanonical ?? null,
          lastCrawlTime: status.lastCrawlTime ?? null,
          crawledAs: status.crawledAs ?? null,
        }
      : {}),
    error:
      input.error ??
      (input.result ? null : "Search Console returned no inspection result"),
  };
}

async function inspectProject(
  projectId: string,
  pages: { url: string; siteUrl: string }[],
  inspectedAt: string,
): Promise<{ written: number; failed: number }> {
  const targets = pages.map((page) => ({
    url: page.url,
    inspectedUrl: inspectionUrlFor(page.url, page.siteUrl),
  }));
  const rows: UrlInspectionWrite[] = targets
    .filter((target) => target.inspectedUrl === null)
    .map((target) =>
      toWrite({
        projectId,
        url: target.url,
        inspectedUrl: target.url,
        inspectedAt,
        error: "URL is outside the Search Console property",
      }),
    );
  const inspectable = targets.flatMap((target) =>
    target.inspectedUrl
      ? [{ url: target.url, inspectedUrl: target.inspectedUrl }]
      : [],
  );
  if (inspectable.length > 0) {
    try {
      const { results } = await GscService.inspectUrls({
        projectId,
        urls: inspectable.map((target) => target.inspectedUrl),
      });
      const byUrl = new Map(results.map((result) => [result.url, result]));
      for (const target of inspectable) {
        const result = byUrl.get(target.inspectedUrl);
        rows.push(
          toWrite({
            projectId,
            ...target,
            inspectedAt,
            result: result?.result ?? null,
            error: result?.error,
          }),
        );
      }
    } catch (error) {
      // Token or grant failure: record it on every URL so they back off a day.
      const message =
        error instanceof Error ? error.message : "Inspection failed";
      for (const target of inspectable) {
        rows.push(
          toWrite({ projectId, ...target, inspectedAt, error: message }),
        );
      }
    }
  }
  await UrlInspectionRepository.upsertMany(rows);
  return { written: rows.length, failed: rows.filter((r) => r.error).length };
}

/** Cron body: inspect up to INSPECTIONS_PER_TICK due key pages. Self-host only. */
export async function runScheduledIndexInspections(now = new Date()) {
  if (await isHostedServerAuthMode()) return;
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
  const due = await UrlInspectionRepository.listDueKeyPages(
    cutoff,
    INSPECTIONS_PER_TICK,
  );
  if (due.length === 0) return;

  const inspectedAt = now.toISOString();
  let written = 0;
  let failed = 0;
  for (const [projectId, pages] of Object.entries(
    groupBy(due, (row) => row.projectId),
  )) {
    const result = await inspectProject(projectId, pages, inspectedAt);
    written += result.written;
    failed += result.failed;
  }
  console.log({
    event: "index_inspection_tick",
    due: due.length,
    written,
    failed,
  });
}
