import { BacklinkSnapshotRepository } from "@/server/features/dashboard/repositories/BacklinkSnapshotRepository";
import { backlinksSummaryItemSchema } from "@/server/lib/dataforseo/backlinks";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import type { DataforseoTaskLike } from "@/server/lib/dataforseo/envelope";
import { normalizeBacklinksTarget } from "@/server/lib/dataforseoBacklinksTarget";
import { AppError } from "@/server/lib/errors";
import { requireProjectDomain } from "./reportDomain";
import { ReportApiError, toDataforseoReportApiError } from "./reportErrors";
import { readJsonBody, type ReportContext } from "./reportRequest";
import { backlinksBodySchemas, isBacklinksKind } from "./reportSchemas";

const DFS_OK = 20000;

/** brrhlv sends no rank_scale, so DataForSEO answers on its default 0–1000
 *  scale; OpenSEO's dashboard snapshots are written with rank_scale
 *  "one_hundred". The raw response keeps the 0–1000 value. */
function toHundredScale(rank: number | null | undefined): number | null {
  return typeof rank === "number" ? Math.round(rank / 10) : null;
}

/** True when the summary request uses the same parameters the dashboard
 *  collector uses: all live backlinks, indirect links included. Requests that
 *  filter to a subset (lost only, no indirect links, etc.) must not overwrite
 *  the snapshot row because it would corrupt OpenSEO's own history chart. */
function isDashboardEquivalentSummary(body: Record<string, unknown>): boolean {
  if (body.include_subdomains === false) return false;
  if (body.include_indirect_links === false) return false;
  if (
    body.backlinks_status_type !== undefined &&
    body.backlinks_status_type !== "live"
  )
    return false;
  return true;
}

/** One backlink_snapshots row per project per UTC day, so OpenSEO's own
 *  history grows monthly even when nobody opens the dashboard. Concurrent
 *  same-day calls can each read no row and both insert — accepted, same as
 *  the dashboard. */
async function recordSummarySnapshot(
  projectId: string,
  domain: string,
  task: DataforseoTaskLike,
  now: Date,
) {
  if (task.status_code !== DFS_OK) return;
  const parsed = backlinksSummaryItemSchema.safeParse(task.result?.[0]);
  if (!parsed.success) return;
  const summary = parsed.data;
  const capturedAt = now.toISOString();
  const values = {
    rank: toHundredScale(summary.rank),
    backlinks: summary.backlinks ?? null,
    referringDomains: summary.referring_domains ?? null,
    brokenBacklinks: summary.broken_backlinks ?? null,
    newBacklinks: summary.new_backlinks ?? null,
    lostBacklinks: summary.lost_backlinks ?? null,
    newReferringDomains:
      summary.new_referring_domains ?? summary.new_reffering_domains ?? null,
    lostReferringDomains:
      summary.lost_referring_domains ?? summary.lost_reffering_domains ?? null,
    capturedAt,
  };
  const latest =
    await BacklinkSnapshotRepository.getLatestForProject(projectId);
  // Both stored formats ("…T…Z" and "YYYY-MM-DD HH:MM:SS") start YYYY-MM-DD.
  const sameDay =
    latest !== null &&
    latest.domain === domain &&
    latest.capturedAt.slice(0, 10) === capturedAt.slice(0, 10);
  if (latest && sameDay) {
    await BacklinkSnapshotRepository.updateById(latest.id, values);
  } else {
    await BacklinkSnapshotRepository.insert({ projectId, domain, ...values });
  }
}

/** R5: a brrhlv-built DataForSEO backlinks task, target forced to the key's
 *  project domain, endpoint from a fixed allowlist; tasks[0] returned whole. */
async function runBacklinksReport(
  ctx: ReportContext,
  kind: string,
  now = new Date(),
) {
  if (!isBacklinksKind(kind)) throw new ReportApiError(404, "not_found");
  const body = await readJsonBody(ctx.request, backlinksBodySchemas[kind]);
  const domain = requireProjectDomain(ctx.project.domain);
  // Same target the dashboard snapshot uses: the whole site incl. subdomains.
  // A stored domain that isn't a valid target counts as "no usable domain".
  let target: string;
  try {
    target = normalizeBacklinksTarget(domain, {
      scope: "subdomains",
    }).apiTarget;
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_ERROR") {
      throw new ReportApiError(409, "no_domain");
    }
    throw error;
  }

  let response: Awaited<ReturnType<typeof dataforseoPost>>;
  try {
    response = await dataforseoPost(`/v3/backlinks/${kind}/live`, [
      { ...body, target },
    ]);
  } catch (error) {
    throw toDataforseoReportApiError(error);
  }
  const task = response?.tasks?.[0];
  if (!response || response.status_code !== DFS_OK || !task) {
    throw new ReportApiError(502, "upstream_error", {
      status: response?.status_code ?? 0,
    });
  }

  if (
    kind === "summary" &&
    isDashboardEquivalentSummary(body as Record<string, unknown>)
  ) {
    try {
      await recordSummarySnapshot(ctx.project.id, domain, task, now);
    } catch (error) {
      // The call is already billed; the report data is still valid.
      console.error(
        "report-api: backlink snapshot write failed",
        { projectId: ctx.project.id },
        error,
      );
    }
  }

  return {
    target,
    costUsd: typeof task.cost === "number" ? task.cost : 0,
    response: task,
  };
}

export const ReportBacklinksService = { runBacklinksReport };
