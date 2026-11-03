import type { GbpWatchView } from "@/server/features/gbp-watch/gbpWatchView";
import { GbpWatchService } from "@/server/features/gbp-watch/services/GbpWatchService";

/**
 * CLIENT-SBLV-193: the summary's `gbp` section, the stored GBP watch (no
 * DataForSEO call). `tracked` is false without an active watch; `profile` is
 * null until the first snapshot. Additive: older consumers ignore the key.
 * The accepted state itself stays MCP-only; drift items carry its values.
 */
export async function getGbpSection(
  projectId: string,
  now: Date,
): Promise<GbpWatchView> {
  const { expected: _expected, ...view } = await GbpWatchService.getWatch(
    projectId,
    now,
  );
  return view;
}
