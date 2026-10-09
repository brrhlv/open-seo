import { sortBy } from "remeda";
import { z } from "zod";
import type {
  AiVisibilityConfig,
  AiVisibilitySnapshotInsert,
  AiVisibilitySnapshotRow,
} from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import { detectTarget } from "@/shared/targetDetection";
import type { BrandLookupResult } from "@/types/schemas/ai-search";

/**
 * PAI-217: pure mapping between a Brand Lookup result, the stored
 * ai_visibility_snapshots rows, and the month-over-month read model.
 */

export const AI_VISIBILITY_PLATFORMS = ["chat_gpt", "google"] as const;
export type AiVisibilityPlatform = (typeof AI_VISIBILITY_PLATFORMS)[number];

const STORED_SOURCES = 10;
const STORED_PROMPTS = 10;

// ---------------------------------------------------------------------------
// Stored JSON shapes
// ---------------------------------------------------------------------------

const topSourcesSchema = z.array(
  z.object({
    url: z.string(),
    domain: z.string().nullable(),
    mentions: z.number().nullable(),
  }),
);
const samplePromptsSchema = z.array(
  z.object({
    question: z.string(),
    aiSearchVolume: z.number().nullable(),
  }),
);
const shareOfVoiceSchema = z.object({
  targetPct: z.number().nullable(),
  entries: z.array(
    z.object({
      label: z.string(),
      isTarget: z.boolean(),
      mentions: z.number().nullable(),
      sharePct: z.number().nullable(),
    }),
  ),
});

type StoredShareOfVoice = z.infer<typeof shareOfVoiceSchema>;

function parseJson<T>(schema: z.ZodType<T>, raw: string | null, fallback: T) {
  if (raw == null) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Lookup → rows
// ---------------------------------------------------------------------------

/**
 * One row per platform whose Brand Lookup call succeeded. A failed platform
 * writes nothing, so the month stays incomplete and the next run retries it.
 * The run's DataForSEO cost is split evenly across the rows written; sum the
 * rows for a run total.
 */
export function snapshotRowsFromLookup(
  result: BrandLookupResult,
  meta: {
    projectId: string;
    period: string;
    capturedAt: string;
    costUsd: number;
  },
): AiVisibilitySnapshotInsert[] {
  const succeeded = result.perPlatform.filter((p) => p.status === "success");
  const targetHost =
    result.detectedTargetType === "domain"
      ? detectTarget(result.resolvedTarget).value
      : null;
  const costPerRow = succeeded.length > 0 ? meta.costUsd / succeeded.length : 0;

  return succeeded.map((platform) => {
    const pages = result.topPages.filter(
      (page) => page.platform === platform.platform,
    );
    const ownPages = targetHost
      ? pages.filter(
          (page) =>
            page.domain === targetHost ||
            (page.domain?.endsWith(`.${targetHost}`) ?? false),
        )
      : pages;
    const sov =
      result.shareOfVoiceByPlatform.find(
        (entry) => entry.platform === platform.platform,
      )?.shareOfVoice ?? null;
    const storedSov: StoredShareOfVoice | null = sov
      ? {
          targetPct: sov.entries.find((e) => e.isTarget)?.sharePct ?? null,
          entries: sov.entries,
        }
      : null;

    return {
      projectId: meta.projectId,
      domain: result.resolvedTarget,
      platform: platform.platform,
      period: meta.period,
      mentions: platform.mentions,
      aiSearchVolume: platform.aiSearchVolume,
      citedPages: ownPages.length,
      topSourcesJson: JSON.stringify(
        pages.slice(0, STORED_SOURCES).map((page) => ({
          url: page.url,
          domain: page.domain,
          mentions: page.mentions,
        })),
      ),
      samplePromptsJson: JSON.stringify(
        result.topQueries
          .filter((query) => query.platform === platform.platform)
          .slice(0, STORED_PROMPTS)
          .map((query) => ({
            question: query.question,
            aiSearchVolume: query.aiSearchVolume,
          })),
      ),
      shareOfVoiceJson: storedSov ? JSON.stringify(storedSov) : null,
      billingCostUsd: costPerRow,
      capturedAt: meta.capturedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export type AiVisibilityPoint = {
  period: string;
  capturedAt: string;
  mentions: number | null;
  aiSearchVolume: number | null;
  citedPages: number;
  shareOfVoicePct: number | null;
};

export type AiVisibilityPlatformSummary = AiVisibilityPoint & {
  platform: AiVisibilityPlatform;
  topSources: z.infer<typeof topSourcesSchema>;
  samplePrompts: z.infer<typeof samplePromptsSchema>;
  shareOfVoice: StoredShareOfVoice | null;
  billingCostUsd: number;
  previous: AiVisibilityPoint | null;
  /** Latest minus previous month; null when there is no previous month. */
  delta: {
    mentions: number | null;
    citedPages: number;
    shareOfVoicePct: number | null;
  } | null;
};

export type AiVisibilityHistory = {
  config: AiVisibilityConfig | null;
  latest: AiVisibilityPlatformSummary[];
  /** Oldest first, one point per platform per month. */
  history: Array<AiVisibilityPoint & { platform: AiVisibilityPlatform }>;
};

function toPoint(row: AiVisibilitySnapshotRow): AiVisibilityPoint {
  const sov = parseJson(shareOfVoiceSchema, row.shareOfVoiceJson, null);
  return {
    period: row.period,
    capturedAt: row.capturedAt,
    mentions: row.mentions,
    aiSearchVolume: row.aiSearchVolume,
    citedPages: row.citedPages,
    shareOfVoicePct: sov?.targetPct ?? null,
  };
}

function diff(a: number | null, b: number | null): number | null {
  return a == null || b == null ? null : a - b;
}

/** Pure: summarize stored rows (any order) into latest + deltas + history. */
export function summarizeSnapshots(
  rows: AiVisibilitySnapshotRow[],
): Omit<AiVisibilityHistory, "config"> {
  const ordered = sortBy(rows, [(row) => row.period, "asc"]);
  const latest = AI_VISIBILITY_PLATFORMS.flatMap((platform) => {
    const platformRows = ordered.filter((row) => row.platform === platform);
    const last = platformRows.at(-1);
    if (!last) return [];
    const prevRow = platformRows.at(-2);
    const point = toPoint(last);
    const previous = prevRow ? toPoint(prevRow) : null;
    return [
      {
        ...point,
        platform,
        topSources: parseJson(topSourcesSchema, last.topSourcesJson, []),
        samplePrompts: parseJson(
          samplePromptsSchema,
          last.samplePromptsJson,
          [],
        ),
        shareOfVoice: parseJson(
          shareOfVoiceSchema,
          last.shareOfVoiceJson,
          null,
        ),
        billingCostUsd: last.billingCostUsd,
        previous,
        delta: previous
          ? {
              mentions: diff(point.mentions, previous.mentions),
              citedPages: point.citedPages - previous.citedPages,
              shareOfVoicePct: diff(
                point.shareOfVoicePct,
                previous.shareOfVoicePct,
              ),
            }
          : null,
      },
    ];
  });
  return {
    latest,
    history: ordered.map((row) => ({
      ...toPoint(row),
      platform: row.platform,
    })),
  };
}
