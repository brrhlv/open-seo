import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  localGridCells,
  localGridConfigs,
  localGridKeywords,
  localGridSnapshots,
  projects,
} from "@/db/schema";

export type LocalGridConfig = typeof localGridConfigs.$inferSelect;
export type LocalGridSnapshotRow = typeof localGridSnapshots.$inferSelect;
export type LocalGridCellRow = typeof localGridCells.$inferSelect;
type LocalGridSnapshotInsert = Omit<
  typeof localGridSnapshots.$inferInsert,
  "id"
>;
type LocalGridCellInsert = Omit<
  typeof localGridCells.$inferInsert,
  "id" | "snapshotId"
>;
type LocalGridConfigValues = Omit<
  typeof localGridConfigs.$inferInsert,
  "id" | "createdAt" | "lastCheckedAt" | "lastError"
>;

// 10 bound columns per cell plus 3 for the snapshot lookup; D1 caps a
// statement at ~100 parameters.
const CELLS_PER_INSERT = 6;

async function getConfigForProject(
  projectId: string,
): Promise<LocalGridConfig | null> {
  const rows = await db
    .select()
    .from(localGridConfigs)
    .where(eq(localGridConfigs.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

/** One tracker per project: a second create updates the existing row. */
async function upsertConfig(
  values: LocalGridConfigValues,
): Promise<LocalGridConfig> {
  const { projectId: _projectId, ...updatable } = values;
  const [row] = await db
    .insert(localGridConfigs)
    .values({ id: crypto.randomUUID(), ...values })
    .onConflictDoUpdate({ target: localGridConfigs.projectId, set: updatable })
    .returning();
  if (!row) throw new Error("Failed to upsert local_grid_config");
  return row;
}

type LocalGridKeywordRow = {
  id: string;
  keyword: string;
  attempts: number;
  attemptPeriod: string | null;
};

/** Tracker keywords in the order they were added, with this month's attempts. */
async function listKeywords(configId: string): Promise<LocalGridKeywordRow[]> {
  return db
    .select({
      id: localGridKeywords.id,
      keyword: localGridKeywords.keyword,
      attempts: localGridKeywords.attempts,
      attemptPeriod: localGridKeywords.attemptPeriod,
    })
    .from(localGridKeywords)
    .where(eq(localGridKeywords.configId, configId))
    .orderBy(asc(localGridKeywords.createdAt), asc(localGridKeywords.id));
}

/** Replace the tracker's keyword list in one atomic write. */
async function replaceKeywords(
  configId: string,
  keywords: string[],
): Promise<void> {
  // Stagger created_at so the read order is the order given.
  const base = Date.now();
  await runBatch((tx) => [
    tx
      .delete(localGridKeywords)
      .where(eq(localGridKeywords.configId, configId)),
    ...(keywords.length === 0
      ? []
      : [
          tx.insert(localGridKeywords).values(
            keywords.map((keyword, i) => ({
              id: crypto.randomUUID(),
              configId,
              keyword,
              createdAt: new Date(base + i).toISOString(),
            })),
          ),
        ]),
  ]);
}

/** Count a failed or degraded run against the keyword for the period. */
async function recordAttempt(keywordId: string, period: string): Promise<void> {
  await db
    .update(localGridKeywords)
    .set({
      attempts: sql`case when ${localGridKeywords.attemptPeriod} = ${period} then ${localGridKeywords.attempts} + 1 else 1 end`,
      attemptPeriod: period,
    })
    .where(eq(localGridKeywords.id, keywordId));
}

/** Active monthly trackers that are due and not held by a run, oldest first. */
async function getDueConfigsWithOrganization(nowIso: string, limit: number) {
  return db
    .select({
      id: localGridConfigs.id,
      projectId: localGridConfigs.projectId,
      nextCheckAt: localGridConfigs.nextCheckAt,
      organizationId: projects.organizationId,
    })
    .from(localGridConfigs)
    .innerJoin(projects, eq(localGridConfigs.projectId, projects.id))
    .where(
      and(
        eq(localGridConfigs.isActive, true),
        eq(localGridConfigs.scheduleInterval, "monthly"),
        lte(localGridConfigs.nextCheckAt, nowIso),
        or(
          isNull(localGridConfigs.leaseUntil),
          lte(localGridConfigs.leaseUntil, nowIso),
        ),
        isNull(projects.archivedAt),
      ),
    )
    .orderBy(asc(localGridConfigs.nextCheckAt), asc(localGridConfigs.id))
    .limit(limit);
}

/**
 * Take the tracker's run lease (compare-and-set), so a cron tick and an MCP
 * run never grid the same tracker at once. false when another run holds it.
 */
async function acquireLease(input: {
  configId: string;
  nowIso: string;
  leaseUntil: string;
}): Promise<boolean> {
  const claimed = await db
    .update(localGridConfigs)
    .set({ leaseUntil: input.leaseUntil })
    .where(
      and(
        eq(localGridConfigs.id, input.configId),
        or(
          isNull(localGridConfigs.leaseUntil),
          lte(localGridConfigs.leaseUntil, input.nowIso),
        ),
      ),
    )
    .returning({ id: localGridConfigs.id });
  return claimed.length > 0;
}

async function updateConfig(
  configId: string,
  values: Partial<
    Pick<
      LocalGridConfig,
      "lastCheckedAt" | "lastError" | "nextCheckAt" | "isActive" | "leaseUntil"
    >
  >,
): Promise<void> {
  await db
    .update(localGridConfigs)
    .set(values)
    .where(eq(localGridConfigs.id, configId));
}

/** The period's stored snapshots: keyword and how many points failed. */
async function listPeriodSnapshots(projectId: string, period: string) {
  return db
    .select({
      keyword: localGridSnapshots.keyword,
      pointsSearched: localGridSnapshots.pointsSearched,
      pointsFailed: localGridSnapshots.pointsFailed,
    })
    .from(localGridSnapshots)
    .where(
      and(
        eq(localGridSnapshots.projectId, projectId),
        eq(localGridSnapshots.period, period),
      ),
    );
}

/**
 * Store one keyword's grid for the month in one atomic batch. A re-run in the
 * same month replaces the snapshot's figures and cells; its billing_cost_usd
 * accumulates so the month's total spend stays visible. The cells find their
 * snapshot through its unique key, so no id round trip splits the batch.
 */
async function saveSnapshot(
  snapshot: LocalGridSnapshotInsert,
  cells: LocalGridCellInsert[],
): Promise<void> {
  const {
    projectId: _projectId,
    keyword: _keyword,
    period: _period,
    billingCostUsd: _billingCostUsd,
    ...replaced
  } = snapshot;
  const snapshotId = sql<number>`(select ${localGridSnapshots.id} from ${localGridSnapshots} where ${localGridSnapshots.projectId} = ${snapshot.projectId} and ${localGridSnapshots.keyword} = ${snapshot.keyword} and ${localGridSnapshots.period} = ${snapshot.period})`;
  const chunks: LocalGridCellInsert[][] = [];
  for (let i = 0; i < cells.length; i += CELLS_PER_INSERT) {
    chunks.push(cells.slice(i, i + CELLS_PER_INSERT));
  }
  await runBatch((tx) => [
    tx
      .insert(localGridSnapshots)
      .values(snapshot)
      .onConflictDoUpdate({
        target: [
          localGridSnapshots.projectId,
          localGridSnapshots.keyword,
          localGridSnapshots.period,
        ],
        set: {
          ...replaced,
          billingCostUsd: sql`${localGridSnapshots.billingCostUsd} + excluded.billing_cost_usd`,
        },
      }),
    tx.delete(localGridCells).where(eq(localGridCells.snapshotId, snapshotId)),
    ...chunks.map((chunk) =>
      tx
        .insert(localGridCells)
        .values(chunk.map((cell) => ({ ...cell, snapshotId }))),
    ),
  ]);
}

/** Newest month first; never metered. */
async function listRecentSnapshots(
  projectId: string,
  limit: number,
): Promise<LocalGridSnapshotRow[]> {
  return db
    .select()
    .from(localGridSnapshots)
    .where(eq(localGridSnapshots.projectId, projectId))
    .orderBy(desc(localGridSnapshots.period), asc(localGridSnapshots.keyword))
    .limit(limit);
}

/** Cells of the given snapshots, row-major per snapshot. */
async function listCells(snapshotIds: number[]): Promise<LocalGridCellRow[]> {
  if (snapshotIds.length === 0) return [];
  return db
    .select()
    .from(localGridCells)
    .where(inArray(localGridCells.snapshotId, snapshotIds))
    .orderBy(
      asc(localGridCells.snapshotId),
      asc(localGridCells.row),
      asc(localGridCells.col),
    );
}

export const LocalGridRepository = {
  getConfigForProject,
  upsertConfig,
  listKeywords,
  replaceKeywords,
  recordAttempt,
  getDueConfigsWithOrganization,
  acquireLease,
  updateConfig,
  listPeriodSnapshots,
  saveSnapshot,
  listRecentSnapshots,
  listCells,
};
