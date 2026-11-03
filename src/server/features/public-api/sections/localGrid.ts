import { getLocalGridSummary } from "@/server/features/local-grid/services/localGridSummary";

/**
 * CLIENT-SBLV-191: stored Maps rank grids (no DataForSEO call). `tracked` is
 * false without an active tracker; `keywords` is empty until the first run.
 * Additive — consumers that predate it ignore the key.
 */
export function getLocalGridSection(projectId: string) {
  return getLocalGridSummary(projectId);
}
