import { sort } from "remeda";
import { z } from "zod";
import { AI_VISIBILITY_PROMPT_PLATFORMS } from "@/db/ai-visibility.schema";
import {
  AiVisibilityPromptRepository,
  type AiVisibilityPromptResultRow,
  type AiVisibilityPromptRow,
} from "@/server/features/ai-visibility/repositories/AiVisibilityPromptRepository";
import type {
  PromptCompetitorHit,
  PromptPlatform,
} from "@/server/features/ai-visibility/services/promptAnswers";

// PAI-255: reading stored buyer prompts and their results (never metered).

// Months of stored results scanned for "latest" and "previous".
const RESULT_HISTORY_MONTHS = 24;

const platformsSchema = z.array(z.enum(AI_VISIBILITY_PROMPT_PLATFORMS));

/** Stored platforms, in canonical order; unknown keys are dropped. */
export function parsePlatforms(json: string): PromptPlatform[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : [];
  const known = platformsSchema.safeParse(
    list.filter((v): v is string => typeof v === "string"),
  );
  const values = new Set(known.success ? known.data : []);
  return AI_VISIBILITY_PROMPT_PLATFORMS.filter((p) => values.has(p));
}

export type PromptView = {
  id: string;
  prompt: string;
  platforms: PromptPlatform[];
  isActive: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
};

export function toPromptView(row: AiVisibilityPromptRow): PromptView {
  return {
    id: row.id,
    prompt: row.prompt,
    platforms: parsePlatforms(row.platformsJson),
    isActive: row.isActive,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}

export type PromptRunView = {
  period: string;
  capturedAt: string;
  status: "ok" | "error";
  mentioned: boolean | null;
  position: number | null;
  brandsNamed: number | null;
  citedUrl: string | null;
  competitors: PromptCompetitorHit[];
  excerpt: string | null;
  error: string | null;
};

export type PromptPlatformResultView = {
  platform: PromptPlatform;
  latest: PromptRunView;
  previous: Omit<PromptRunView, "excerpt" | "competitors"> | null;
};

const competitorsSchema = z.array(
  z.object({
    domain: z.string(),
    name: z.string().nullable(),
    position: z.number(),
  }),
);

function parseCompetitors(json: string): PromptCompetitorHit[] {
  try {
    const parsed = competitorsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function toRunView(row: AiVisibilityPromptResultRow): PromptRunView {
  return {
    period: row.period,
    capturedAt: row.capturedAt,
    status: row.status,
    mentioned: row.mentioned,
    position: row.position,
    brandsNamed: row.brandsNamed,
    citedUrl: row.citedUrl,
    competitors: parseCompetitors(row.competitorsJson),
    excerpt: row.excerpt,
    error: row.error,
  };
}

/** Active prompts with, per platform, the latest run and the one before it. */
export async function getPromptResults(projectId: string) {
  const prompts = await AiVisibilityPromptRepository.listPrompts(projectId);
  const rows = await AiVisibilityPromptRepository.listRecentResults(
    prompts.map((p) => p.id),
    prompts.length *
      AI_VISIBILITY_PROMPT_PLATFORMS.length *
      RESULT_HISTORY_MONTHS,
  );
  // rows are newest period first, so the first two per key are latest/previous.
  const grouped = new Map<string, AiVisibilityPromptResultRow[]>();
  for (const row of rows) {
    const key = `${row.promptId}:${row.platform}`;
    const list = grouped.get(key) ?? [];
    if (list.length < 2) list.push(row);
    grouped.set(key, list);
  }

  const items = prompts.map((prompt) => ({
    ...toPromptView(prompt),
    results: AI_VISIBILITY_PROMPT_PLATFORMS.flatMap(
      (platform): PromptPlatformResultView[] => {
        const [latest, previous] =
          grouped.get(`${prompt.id}:${platform}`) ?? [];
        if (!latest) return [];
        const prev = previous ? toRunView(previous) : null;
        return [
          {
            platform,
            latest: toRunView(latest),
            previous: prev
              ? {
                  period: prev.period,
                  capturedAt: prev.capturedAt,
                  status: prev.status,
                  mentioned: prev.mentioned,
                  position: prev.position,
                  brandsNamed: prev.brandsNamed,
                  citedUrl: prev.citedUrl,
                  error: prev.error,
                }
              : null,
          },
        ];
      },
    ),
  }));

  const captured = sort(
    rows.map((r) => r.capturedAt),
    (a, b) => a.localeCompare(b),
  );
  const nextRuns = sort(
    prompts.map((p) => p.nextRunAt).filter((v): v is string => v !== null),
    (a, b) => a.localeCompare(b),
  );
  return {
    lastRunAt: captured.at(-1) ?? null,
    nextRunAt: nextRuns[0] ?? null,
    items,
  };
}
