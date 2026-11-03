import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
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

// 11 bound columns per cell; D1 caps a statement at ~100 parameters.
const CELLS_PER_INSERT = 8;

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

/** Tracker keywords in the order they were added. */
async function listKeywords(configId: string): Promise<string[]> {
  const rows = await db
    .select({ keyword: localGridKeywords.keyword })
    .from(localGridKeywords)
    .where(eq(localGridKeywords.configId, configId))
    .orderBy(asc(localGridKeywords.createdAt), asc(localGridKeywords.id));
  return rows.map((row) => row.keyword);
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

/** Active monthly trackers whose next check is due, oldest first. */
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
        isNull(projects.archivedAt),
      ),
    )
    .orderBy(asc(localGridConfigs.nextCheckAt), asc(localGridConfigs.id))
    .limit(limit);
}

/**
 * Compare-and-set the schedule anchor so two overlapping cron ticks cannot
 * both run the same tracker. Returns false when another writer moved it first.
 */
async function claimDueConfig(input: {
  configId: string;
  observedNextCheckAt: string;
  nextCheckAt: string;
}): Promise<boolean> {
  const claimed = await db
    .update(localGridConfigs)
    .set({ nextCheckAt: input.nextCheckAt })
    .where(
      and(
        eq(localGridConfigs.id, input.configId),
        eq(localGridConfigs.isActive, true),
        eq(localGridConfigs.nextCheckAt, input.observedNextCheckAt),
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
      "lastCheckedAt" | "lastError" | "nextCheckAt" | "isActive"
    >
  >,
): Promise<void> {
  await db
    .update(localGridConfigs)
    .set(values)
    .where(eq(localGridConfigs.id, configId));
}

/** Keywords that already have a snapshot for the period. */
async function listCapturedKeywords(
  projectId: string,
  period: string,
): Promise<string[]> {
  const rows = await db
    .select({ keyword: localGridSnapshots.keyword })
    .from(localGridSnapshots)
    .where(
      and(
        eq(localGridSnapshots.projectId, projectId),
        eq(localGridSnapshots.period, period),
      ),
    );
  return rows.map((row) => row.keyword);
}

/**
 * Store one keyword's grid for the month. A re-run in the same month replaces
 * the snapshot's figures and cells; its billing_cost_usd accumulates so the
 * month's total spend stays visible.
 */
async function saveSnapshot(
  snapshot: LocalGridSnapshotInsert,
  cells: LocalGridCellInsert[],
): Promise<number> {
  const {
    projectId: _projectId,
    keyword: _keyword,
    period: _period,
    billingCostUsd: _billingCostUsd,
    ...replaced
  } = snapshot;
  const [row] = await db
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
    })
    .returning({ id: localGridSnapshots.id });
  if (!row) throw new Error("Failed to upsert local_grid_snapshot");
  const snapshotId = row.id;

  const chunks: LocalGridCellInsert[][] = [];
  for (let i = 0; i < cells.length; i += CELLS_PER_INSERT) {
    chunks.push(cells.slice(i, i + CELLS_PER_INSERT));
  }
  await runBatch((tx) => [
    tx.delete(localGridCells).where(eq(localGridCells.snapshotId, snapshotId)),
    ...chunks.map((chunk) =>
      tx
        .insert(localGridCells)
        .values(chunk.map((cell) => ({ ...cell, snapshotId }))),
    ),
  ]);
  return snapshotId;
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
  getDueConfigsWithOrganization,
  claimDueConfig,
  updateConfig,
  listCapturedKeywords,
  saveSnapshot,
  listRecentSnapshots,
  listCells,
};
