import { sort, sortBy } from "remeda";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import {
  UrlInspectionRepository,
  type UrlInspectionRow,
} from "@/server/features/gsc/repositories/UrlInspectionRepository";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { toIsoTimestamp } from "../timestamps";

// CLIENT-SBLV-194: stored URL Inspection of the project's key pages. Never
// calls Google — the */5 cron (scheduledIndexInspections, self-host only)
// refreshes the rows at most once a day per URL.

type IndexState = "indexed" | "not_indexed" | "failed" | "pending";

/** The last good verdict wins over a later failed check; a failure only
 *  shows when there was never a verdict. */
function stateOf(row: UrlInspectionRow | undefined): IndexState {
  if (row?.verdict) return row.verdict === "PASS" ? "indexed" : "not_indexed";
  if (!row || (!row.error && !row.inspectedAt)) return "pending";
  // An error, or a result without a verdict.
  return "failed";
}

function toPage(url: string, row: UrlInspectionRow | undefined) {
  return {
    url,
    inspectedUrl: row?.inspectedUrl ?? null,
    state: stateOf(row),
    verdict: row?.verdict ?? null,
    coverageState: row?.coverageState ?? null,
    indexingState: row?.indexingState ?? null,
    robotsTxtState: row?.robotsTxtState ?? null,
    pageFetchState: row?.pageFetchState ?? null,
    googleCanonical: row?.googleCanonical ?? null,
    userCanonical: row?.userCanonical ?? null,
    canonicalMismatch: Boolean(
      row?.googleCanonical &&
      row.userCanonical &&
      row.googleCanonical !== row.userCanonical,
    ),
    lastCrawlTime: row?.lastCrawlTime ?? null,
    crawledAs: row?.crawledAs ?? null,
    // When the result above was captured.
    inspectedAt: toIsoTimestamp(row?.inspectedAt),
    // The last attempt and its error, if it failed.
    checkedAt: row?.error ? toIsoTimestamp(row.attemptedAt) : null,
    error: row?.error ?? null,
  };
}

const latest = (values: (string | null)[]) =>
  sort(
    values.filter((v): v is string => v !== null),
    (a, b) => a.localeCompare(b),
  );

export async function getIndexStatusSection(projectId: string) {
  // Hosted mode never runs the inspection cron.
  if (await isHostedServerAuthMode()) return { connected: false as const };
  const [connection, keyPages, rows] = await Promise.all([
    GscConnectionRepository.getByProjectId(projectId),
    ProjectContextRepository.listKeyPages(projectId),
    UrlInspectionRepository.listForProject(projectId),
  ]);
  if (!connection) return { connected: false as const };

  const byUrl = new Map(rows.map((row) => [row.url, row]));
  const pages = sortBy(
    keyPages.map((page) => toPage(page.url, byUrl.get(page.url))),
    (page) => page.url,
  );
  const inspected = latest(pages.map((page) => page.inspectedAt));
  const nextChecks = latest(
    keyPages.map((page) => toIsoTimestamp(byUrl.get(page.url)?.nextCheckAt)),
  );
  const counts = { indexed: 0, notIndexed: 0, failed: 0, pending: 0 };
  for (const page of pages) {
    if (page.state === "indexed") counts.indexed++;
    else if (page.state === "not_indexed") counts.notIndexed++;
    else if (page.state === "failed") counts.failed++;
    else counts.pending++;
  }
  return {
    connected: true as const,
    capturedAt: inspected.at(-1) ?? null,
    nextCheckAfter: nextChecks[0] ?? null,
    counts,
    pages,
  };
}
