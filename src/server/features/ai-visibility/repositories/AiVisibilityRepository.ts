import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  aiVisibilityConfigs,
  aiVisibilitySnapshots,
  projects,
} from "@/db/schema";

export type AiVisibilityConfig = typeof aiVisibilityConfigs.$inferSelect;
export type AiVisibilitySnapshotRow = typeof aiVisibilitySnapshots.$inferSelect;
export type AiVisibilitySnapshotInsert = Omit<
  typeof aiVisibilitySnapshots.$inferInsert,
  "id"
>;

async function getConfigForProject(
  projectId: string,
): Promise<AiVisibilityConfig | null> {
  const rows = await db
    .select()
    .from(aiVisibilityConfigs)
    .where(eq(aiVisibilityConfigs.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

/** One tracker per project: a second create updates the existing row. */
async function upsertConfig(values: {
  projectId: string;
  target: string;
  includeCompetitors: boolean;
  scheduleInterval: "monthly" | "manual";
  isActive: boolean;
  nextCheckAt: string | null;
}): Promise<AiVisibilityConfig> {
  const [row] = await db
    .insert(aiVisibilityConfigs)
    .values({ id: crypto.randomUUID(), ...values })
    .onConflictDoUpdate({
      target: aiVisibilityConfigs.projectId,
      set: {
        target: values.target,
        includeCompetitors: values.includeCompetitors,
        scheduleInterval: values.scheduleInterval,
        isActive: values.isActive,
        nextCheckAt: values.nextCheckAt,
      },
    })
    .returning();
  if (!row) throw new Error("Failed to upsert ai_visibility_config");
  return row;
}

/** Active monthly configs whose next check is due, oldest first. */
async function getDueConfigsWithOrganization(nowIso: string, limit: number) {
  return db
    .select({
      id: aiVisibilityConfigs.id,
      projectId: aiVisibilityConfigs.projectId,
      target: aiVisibilityConfigs.target,
      nextCheckAt: aiVisibilityConfigs.nextCheckAt,
      organizationId: projects.organizationId,
    })
    .from(aiVisibilityConfigs)
    .innerJoin(projects, eq(aiVisibilityConfigs.projectId, projects.id))
    .where(
      and(
        eq(aiVisibilityConfigs.isActive, true),
        eq(aiVisibilityConfigs.scheduleInterval, "monthly"),
        lte(aiVisibilityConfigs.nextCheckAt, nowIso),
        isNull(projects.archivedAt),
      ),
    )
    .orderBy(asc(aiVisibilityConfigs.nextCheckAt), asc(aiVisibilityConfigs.id))
    .limit(limit);
}

/**
 * Compare-and-set the schedule anchor so two overlapping cron ticks cannot
 * both run the same config. Returns false when another writer moved it first.
 */
async function claimDueConfig(input: {
  configId: string;
  observedNextCheckAt: string;
  nextCheckAt: string;
}): Promise<boolean> {
  const claimed = await db
    .update(aiVisibilityConfigs)
    .set({ nextCheckAt: input.nextCheckAt })
    .where(
      and(
        eq(aiVisibilityConfigs.id, input.configId),
        eq(aiVisibilityConfigs.isActive, true),
        eq(aiVisibilityConfigs.nextCheckAt, input.observedNextCheckAt),
      ),
    )
    .returning({ id: aiVisibilityConfigs.id });
  return claimed.length > 0;
}

async function updateConfig(
  configId: string,
  values: Partial<
    Pick<
      AiVisibilityConfig,
      "lastCheckedAt" | "lastError" | "nextCheckAt" | "isActive"
    >
  >,
): Promise<void> {
  await db
    .update(aiVisibilityConfigs)
    .set(values)
    .where(eq(aiVisibilityConfigs.id, configId));
}

/**
 * One statement for every platform row of a run. A row for the same
 * (project, platform, period) is replaced with the newer data, and its
 * billing_cost_usd accumulates so the month's total spend stays visible.
 */
async function upsertSnapshots(
  rows: AiVisibilitySnapshotInsert[],
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(aiVisibilitySnapshots)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        aiVisibilitySnapshots.projectId,
        aiVisibilitySnapshots.platform,
        aiVisibilitySnapshots.period,
      ],
      set: {
        domain: sql`excluded.domain`,
        mentions: sql`excluded.mentions`,
        aiSearchVolume: sql`excluded.ai_search_volume`,
        citedPages: sql`excluded.cited_pages`,
        topSourcesJson: sql`excluded.top_sources_json`,
        samplePromptsJson: sql`excluded.sample_prompts_json`,
        shareOfVoiceJson: sql`excluded.share_of_voice_json`,
        billingCostUsd: sql`${aiVisibilitySnapshots.billingCostUsd} + excluded.billing_cost_usd`,
        capturedAt: sql`excluded.captured_at`,
      },
    });
}

async function listSnapshotsForPeriod(
  projectId: string,
  period: string,
): Promise<AiVisibilitySnapshotRow[]> {
  return db
    .select()
    .from(aiVisibilitySnapshots)
    .where(
      and(
        eq(aiVisibilitySnapshots.projectId, projectId),
        eq(aiVisibilitySnapshots.period, period),
      ),
    );
}

/** Newest-first stored snapshots for the project (never metered). */
async function listRecentSnapshots(
  projectId: string,
  limit: number,
): Promise<AiVisibilitySnapshotRow[]> {
  return db
    .select()
    .from(aiVisibilitySnapshots)
    .where(eq(aiVisibilitySnapshots.projectId, projectId))
    .orderBy(
      desc(aiVisibilitySnapshots.period),
      asc(aiVisibilitySnapshots.platform),
    )
    .limit(limit);
}

export const AiVisibilityRepository = {
  getConfigForProject,
  upsertConfig,
  getDueConfigsWithOrganization,
  claimDueConfig,
  updateConfig,
  upsertSnapshots,
  listSnapshotsForPeriod,
  listRecentSnapshots,
};
