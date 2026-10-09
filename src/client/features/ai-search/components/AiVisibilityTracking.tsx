import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import {
  getAiVisibility,
  setAiVisibilityTracking,
} from "@/serverFunctions/ai-visibility";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  formatCount,
  formatPlatformLabel,
  PLATFORM_DOT_CLASS,
} from "@/client/features/ai-search/platformLabels";
import { detectTarget } from "@/shared/targetDetection";
import type {
  AiVisibilityHistory,
  AiVisibilityPlatform,
} from "@/server/features/ai-visibility/services/aiVisibilitySnapshots";

function aiVisibilityQueryKey(projectId: string) {
  return ["aiVisibility", projectId] as const;
}

/** Stored PAI-217 snapshots for the project. D1 read, never metered. */
export function useAiVisibility(projectId: string) {
  return useQuery({
    queryKey: aiVisibilityQueryKey(projectId),
    queryFn: () => getAiVisibility({ data: { projectId } }),
    staleTime: 5 * 60 * 1000,
  });
}

function sameTarget(a: string, b: string): boolean {
  return (
    detectTarget(a).value.toLowerCase() === detectTarget(b).value.toLowerCase()
  );
}

/** Minimal inline sparkline; null points are skipped. */
export function Sparkline({
  values,
  label,
}: {
  values: Array<number | null>;
  label: string;
}) {
  const points = values
    .map((value, index) => ({ value, index }))
    .filter((p): p is { value: number; index: number } => p.value != null);
  if (points.length < 2) {
    return <span className="text-xs text-base-content/40">—</span>;
  }
  const width = 96;
  const height = 24;
  const max = Math.max(...points.map((p) => p.value));
  const min = Math.min(...points.map((p) => p.value));
  const span = max - min || 1;
  const step = width / Math.max(values.length - 1, 1);
  const path = points
    .map((p, i) => {
      const x = p.index * step;
      const y = height - ((p.value - min) / span) * (height - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className="text-primary"
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

function Delta({
  value,
  suffix = "",
}: {
  value: number | null;
  suffix?: string;
}) {
  if (value == null || value === 0) return null;
  const rounded = Math.round(value * 10) / 10;
  const tone = rounded > 0 ? "text-success" : "text-error";
  return (
    <span className={`ml-1 text-xs tabular-nums ${tone}`}>
      {rounded > 0 ? "▲" : "▼"} {Math.abs(rounded)}
      {suffix}
    </span>
  );
}

function formatPct(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

function seriesFor(
  history: AiVisibilityHistory["history"],
  platform: AiVisibilityPlatform,
  key: "mentions" | "shareOfVoicePct",
) {
  return history.filter((p) => p.platform === platform).map((p) => p[key]);
}

/** Month-over-month table: one row per platform with sparklines. */
function AiVisibilityHistoryTable({ data }: { data: AiVisibilityHistory }) {
  if (data.latest.length === 0) {
    return (
      <p className="text-sm text-base-content/60">
        No monthly snapshot yet. The first one is taken on the next scheduled
        check
        {data.config?.nextCheckAt
          ? ` (${data.config.nextCheckAt.slice(0, 10)})`
          : ""}
        .
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Platform</th>
            <th className="text-right">Mentions</th>
            <th>Trend</th>
            <th className="text-right">Cited pages</th>
            <th className="text-right">Share of voice</th>
            <th>Trend</th>
          </tr>
        </thead>
        <tbody>
          {data.latest.map((row) => (
            <tr key={row.platform}>
              <td>
                <span className="inline-flex items-center gap-2">
                  <span
                    className={`size-2 rounded-full ${PLATFORM_DOT_CLASS[row.platform]}`}
                  />
                  {formatPlatformLabel(row.platform)}
                  <span className="text-xs text-base-content/50">
                    {row.period}
                  </span>
                </span>
              </td>
              <td className="text-right tabular-nums">
                {formatCount(row.mentions)}
                <Delta value={row.delta?.mentions ?? null} />
              </td>
              <td>
                <Sparkline
                  values={seriesFor(data.history, row.platform, "mentions")}
                  label={`${formatPlatformLabel(row.platform)} mentions by month`}
                />
              </td>
              <td className="text-right tabular-nums">
                {row.citedPages}
                <Delta value={row.delta?.citedPages ?? null} />
              </td>
              <td className="text-right tabular-nums">
                {formatPct(row.shareOfVoicePct)}
                <Delta
                  value={row.delta?.shareOfVoicePct ?? null}
                  suffix=" pts"
                />
              </td>
              <td>
                <Sparkline
                  values={seriesFor(
                    data.history,
                    row.platform,
                    "shareOfVoicePct",
                  )}
                  label={`${formatPlatformLabel(row.platform)} share of voice by month`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Brand Lookup's tracking card: a "Track this monthly" toggle for the current
 * target plus the stored month-over-month history. With no `target` (the
 * landing view) it shows the project's existing tracker, if any.
 */
export function AiVisibilityTrackingCard({
  projectId,
  target,
}: {
  projectId: string;
  target?: string;
}) {
  const queryClient = useQueryClient();
  const query = useAiVisibility(projectId);
  const mutation = useMutation({
    mutationFn: (input: { target: string; active: boolean }) =>
      setAiVisibilityTracking({ data: { projectId, ...input } }),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: aiVisibilityQueryKey(projectId),
      }),
  });

  const data = query.data;
  const config = data?.config ?? null;
  if (!data || (!target && !config)) return null;

  const toggleTarget = target ?? config?.target ?? "";
  const tracksThis =
    config !== null &&
    config.isActive &&
    sameTarget(config.target, toggleTarget);
  const tracksOther =
    config !== null &&
    config.isActive &&
    !sameTarget(config.target, toggleTarget);

  return (
    <section className="rounded-xl border border-base-300 bg-base-100 p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">AI visibility history</h2>
          <p className="text-xs text-base-content/60">
            {tracksThis
              ? `Snapshotted monthly on the 1st${config.includeCompetitors ? ", with share of voice vs your project competitors" : ""}.`
              : tracksOther
                ? `This project tracks ${config.target}. Turning this on switches the tracker to ${toggleTarget}.`
                : "Turn on to snapshot this lookup on the 1st of each month."}
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="toggle toggle-primary toggle-sm"
            checked={tracksThis}
            disabled={mutation.isPending || toggleTarget === ""}
            onChange={(event) =>
              mutation.mutate({
                target: toggleTarget,
                active: event.target.checked,
              })
            }
          />
          Track this monthly
        </label>
      </div>
      {mutation.isError ? (
        <p
          role="alert"
          className="mt-2 flex items-center gap-1 text-xs text-error"
        >
          <AlertCircle className="size-3" />
          {getStandardErrorMessage(mutation.error)}
        </p>
      ) : null}
      {config && sameTarget(config.target, toggleTarget) ? (
        <div className="mt-3">
          <AiVisibilityHistoryTable data={data} />
        </div>
      ) : null}
    </section>
  );
}
