import { sortBy } from "remeda";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import {
  UrlInspectionRepository,
  type UrlInspectionRow,
} from "@/server/features/gsc/repositories/UrlInspectionRepository";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import { toIsoTimestamp } from "../timestamps";

// CLIENT-SBLV-194: stored URL Inspection of the project's key pages. Never
// calls Google — the */5 cron (scheduledIndexInspections) refreshes the rows
// at most once a day per URL.

const DAY_MS = 24 * 60 * 60_000;

type IndexState = "indexed" | "not_indexed" | "failed" | "pending";

function stateOf(row: UrlInspectionRow | undefined): IndexState {
  if (!row) return "pending";
  if (row.error) return "failed";
  return row.verdict === "PASS" ? "indexed" : "not_indexed";
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
    inspectedAt: toIsoTimestamp(row?.inspectedAt),
    error: row?.error ?? null,
  };
}

export async function getIndexStatusSection(projectId: string) {
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
  const stamps = pages
    .map((page) => page.inspectedAt)
    .filter((stamp): stamp is string => stamp !== null)
    .sort();
  const oldest = stamps[0];
  const counts = { indexed: 0, notIndexed: 0, failed: 0, pending: 0 };
  for (const page of pages) {
    if (page.state === "indexed") counts.indexed++;
    else if (page.state === "not_indexed") counts.notIndexed++;
    else if (page.state === "failed") counts.failed++;
    else counts.pending++;
  }
  return {
    connected: true as const,
    capturedAt: stamps.at(-1) ?? null,
    nextCheckAfter: oldest
      ? new Date(Date.parse(oldest) + DAY_MS).toISOString()
      : null,
    counts,
    pages,
  };
}
