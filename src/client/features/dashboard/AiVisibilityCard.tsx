import { Link } from "@tanstack/react-router";
import {
  CardShell,
  formatDay,
  moreDetailsClass,
  Stat,
} from "@/client/features/dashboard/cardParts";
import { Sparkline } from "@/client/features/ai-search/components/AiVisibilityTracking";
import {
  formatCount,
  PLATFORM_SHORT_LABEL,
} from "@/client/features/ai-search/platformLabels";
import type { AiVisibilityHistory } from "@/server/features/ai-visibility/services/aiVisibilitySnapshots";

function deltaSub(value: number | null | undefined, suffix = "") {
  if (value == null || value === 0) return null;
  const rounded = Math.round(value * 10) / 10;
  return (
    <p
      className={`text-xs tabular-nums ${rounded > 0 ? "text-success" : "text-error"}`}
    >
      {rounded > 0 ? "▲" : "▼"} {Math.abs(rounded)}
      {suffix} vs last month
    </p>
  );
}

/** Dashboard tile beside Backlink pulse: stored AI-visibility snapshots (PAI-217). */
export function AiVisibilityCard({
  projectId,
  domain,
  data,
}: {
  projectId: string;
  domain: string | null;
  data: AiVisibilityHistory | null;
}) {
  const config = data?.config ?? null;
  const target = config?.target ?? domain ?? undefined;
  const link = (
    <Link
      to="/p/$projectId/brand-lookup"
      params={{ projectId }}
      search={{ q: target, c: undefined, scope: undefined }}
      className={moreDetailsClass}
    >
      {config ? "More details" : "Set up"}
    </Link>
  );

  if (!data || !config || data.latest.length === 0) {
    return (
      <CardShell title="AI visibility" action={link}>
        <p className="text-sm text-base-content/60">
          {config
            ? `Tracking ${config.target}. The first monthly snapshot lands ${config.nextCheckAt ? formatDay(config.nextCheckAt) : "on the next run"}.`
            : "Track how often ChatGPT and Google AI Overview mention you, month over month. Turn it on from Brand Lookup."}
        </p>
      </CardShell>
    );
  }

  const capturedAt = data.latest[0]?.capturedAt;
  return (
    <CardShell
      title="AI visibility"
      stamp={`${config.target} · snapshot ${capturedAt ? formatDay(capturedAt) : "—"}`}
      action={link}
    >
      <div className="grid grid-cols-2 gap-3">
        {data.latest.map((row) => (
          <div key={row.platform} className="space-y-1">
            <Stat
              label={`${PLATFORM_SHORT_LABEL[row.platform]} mentions`}
              value={formatCount(row.mentions)}
              sub={deltaSub(row.delta?.mentions)}
            />
            <Sparkline
              values={data.history
                .filter((p) => p.platform === row.platform)
                .map((p) => p.mentions)}
              label={`${PLATFORM_SHORT_LABEL[row.platform]} mentions by month`}
            />
            <p className="text-xs text-base-content/60">
              Share of voice{" "}
              {row.shareOfVoicePct == null
                ? "—"
                : `${row.shareOfVoicePct.toFixed(1)}%`}
            </p>
          </div>
        ))}
      </div>
    </CardShell>
  );
}
