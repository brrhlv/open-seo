import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  aiVisibilityConfigs,
  aiVisibilityPromptResults,
  aiVisibilityPrompts,
  projects,
} from "@/db/schema";

// PAI-255: buyer prompts and their monthly results.

export type AiVisibilityPromptRow = typeof aiVisibilityPrompts.$inferSelect;
export type AiVisibilityPromptResultRow =
  typeof aiVisibilityPromptResults.$inferSelect;
export type AiVisibilityPromptResultInsert = Omit<
  typeof aiVisibilityPromptResults.$inferInsert,
  "id"
>;

async function listPrompts(
  projectId: string,
  options: { includeInactive?: boolean } = {},
): Promise<AiVisibilityPromptRow[]> {
  return db
    .select()
    .from(aiVisibilityPrompts)
    .where(
      options.includeInactive
        ? eq(aiVisibilityPrompts.projectId, projectId)
        : and(
            eq(aiVisibilityPrompts.projectId, projectId),
            eq(aiVisibilityPrompts.isActive, true),
          ),
    )
    .orderBy(asc(aiVisibilityPrompts.createdAt), asc(aiVisibilityPrompts.id));
}

async function insertPrompts(
  rows: (typeof aiVisibilityPrompts.$inferInsert)[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(aiVisibilityPrompts).values(rows);
}

async function updatePrompt(
  promptId: string,
  values: Partial<
    Pick<
      AiVisibilityPromptRow,
      "isActive" | "platformsJson" | "nextRunAt" | "lastRunAt" | "lastError"
    >
  >,
): Promise<void> {
  await db
    .update(aiVisibilityPrompts)
    .set(values)
    .where(eq(aiVisibilityPrompts.id, promptId));
}

/** Deactivates (keeps history). Returns how many active prompts changed. */
async function deactivatePrompts(
  projectId: string,
  promptIds: string[],
): Promise<number> {
  if (promptIds.length === 0) return 0;
  const rows = await db
    .update(aiVisibilityPrompts)
    .set({ isActive: false, nextRunAt: null })
    .where(
      and(
        eq(aiVisibilityPrompts.projectId, projectId),
        eq(aiVisibilityPrompts.isActive, true),
        inArray(aiVisibilityPrompts.id, promptIds),
      ),
    )
    .returning({ id: aiVisibilityPrompts.id });
  return rows.length;
}

/**
 * Active prompts whose run is due, for projects with an active monthly AI
 * visibility tracker that is not archived. Oldest due first.
 */
async function getDuePromptsWithOrganization(nowIso: string, limit: number) {
  return db
    .select({
      prompt: aiVisibilityPrompts,
      organizationId: projects.organizationId,
      projectDomain: projects.domain,
    })
    .from(aiVisibilityPrompts)
    .innerJoin(projects, eq(aiVisibilityPrompts.projectId, projects.id))
    .innerJoin(
      aiVisibilityConfigs,
      eq(aiVisibilityConfigs.projectId, aiVisibilityPrompts.projectId),
    )
    .where(
      and(
        eq(aiVisibilityPrompts.isActive, true),
        lte(aiVisibilityPrompts.nextRunAt, nowIso),
        eq(aiVisibilityConfigs.isActive, true),
        eq(aiVisibilityConfigs.scheduleInterval, "monthly"),
        isNull(projects.archivedAt),
      ),
    )
    .orderBy(asc(aiVisibilityPrompts.nextRunAt), asc(aiVisibilityPrompts.id))
    .limit(limit);
}

/** Compare-and-set on next_run_at so overlapping ticks can't double-run. */
async function claimDuePrompt(input: {
  promptId: string;
  observedNextRunAt: string;
  nextRunAt: string;
}): Promise<boolean> {
  const claimed = await db
    .update(aiVisibilityPrompts)
    .set({ nextRunAt: input.nextRunAt })
    .where(
      and(
        eq(aiVisibilityPrompts.id, input.promptId),
        eq(aiVisibilityPrompts.isActive, true),
        eq(aiVisibilityPrompts.nextRunAt, input.observedNextRunAt),
      ),
    )
    .returning({ id: aiVisibilityPrompts.id });
  return claimed.length > 0;
}

async function listResultsForPeriod(
  promptIds: string[],
  period: string,
): Promise<AiVisibilityPromptResultRow[]> {
  if (promptIds.length === 0) return [];
  return db
    .select()
    .from(aiVisibilityPromptResults)
    .where(
      and(
        inArray(aiVisibilityPromptResults.promptId, promptIds),
        eq(aiVisibilityPromptResults.period, period),
      ),
    );
}

/** Newest period first, at most `limit` rows. */
async function listRecentResults(
  promptIds: string[],
  limit: number,
): Promise<AiVisibilityPromptResultRow[]> {
  if (promptIds.length === 0) return [];
  return db
    .select()
    .from(aiVisibilityPromptResults)
    .where(inArray(aiVisibilityPromptResults.promptId, promptIds))
    .orderBy(
      desc(aiVisibilityPromptResults.period),
      asc(aiVisibilityPromptResults.promptId),
      asc(aiVisibilityPromptResults.platform),
    )
    .limit(limit);
}

/**
 * One statement per run. A row for the same (prompt, platform, period) is
 * replaced; cost_usd and attempts accumulate across re-runs in the month.
 */
async function upsertResults(
  rows: AiVisibilityPromptResultInsert[],
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(aiVisibilityPromptResults)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        aiVisibilityPromptResults.promptId,
        aiVisibilityPromptResults.platform,
        aiVisibilityPromptResults.period,
      ],
      set: {
        status: sql`excluded.status`,
        mentioned: sql`excluded.mentioned`,
        position: sql`excluded.position`,
        brandsNamed: sql`excluded.brands_named`,
        citedUrl: sql`excluded.cited_url`,
        citedUrlsJson: sql`excluded.cited_urls_json`,
        competitorsJson: sql`excluded.competitors_json`,
        excerpt: sql`excluded.excerpt`,
        model: sql`excluded.model`,
        error: sql`excluded.error`,
        attempts: sql`${aiVisibilityPromptResults.attempts} + 1`,
        costUsd: sql`${aiVisibilityPromptResults.costUsd} + excluded.cost_usd`,
        capturedAt: sql`excluded.captured_at`,
      },
    });
}

export const AiVisibilityPromptRepository = {
  listPrompts,
  insertPrompts,
  updatePrompt,
  deactivatePrompts,
  getDuePromptsWithOrganization,
  claimDuePrompt,
  listResultsForPeriod,
  listRecentResults,
  upsertResults,
};
