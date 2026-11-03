import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { gbpConfigs, gbpSnapshots, projects } from "@/db/schema";

export type GbpConfig = typeof gbpConfigs.$inferSelect;
export type GbpSnapshotRow = typeof gbpSnapshots.$inferSelect;
export type GbpSnapshotInsert = Omit<typeof gbpSnapshots.$inferInsert, "id">;

async function getConfigForProject(
  projectId: string,
): Promise<GbpConfig | null> {
  const rows = await db
    .select()
    .from(gbpConfigs)
    .where(eq(gbpConfigs.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

type ConfigValues = Pick<
  GbpConfig,
  | "projectId"
  | "placeId"
  | "cid"
  | "listingId"
  | "expectedJson"
  | "scheduleInterval"
  | "isActive"
  | "nextCheckAt"
>;

/** One watch per project: a second write updates the existing row. */
async function upsertConfig(values: ConfigValues): Promise<GbpConfig> {
  const { projectId: _projectId, ...set } = values;
  const [row] = await db
    .insert(gbpConfigs)
    .values({ id: crypto.randomUUID(), ...values })
    .onConflictDoUpdate({ target: gbpConfigs.projectId, set })
    .returning();
  if (!row) throw new Error("Failed to upsert gbp_config");
  return row;
}

/** Active weekly watches whose next run is due, oldest first. */
async function getDueConfigs(nowIso: string, limit: number) {
  return db
    .select({
      id: gbpConfigs.id,
      projectId: gbpConfigs.projectId,
      nextCheckAt: gbpConfigs.nextCheckAt,
      organizationId: projects.organizationId,
      locationCode: projects.locationCode,
      languageCode: projects.languageCode,
    })
    .from(gbpConfigs)
    .innerJoin(projects, eq(gbpConfigs.projectId, projects.id))
    .where(
      and(
        eq(gbpConfigs.isActive, true),
        eq(gbpConfigs.scheduleInterval, "weekly"),
        lte(gbpConfigs.nextCheckAt, nowIso),
        isNull(projects.archivedAt),
      ),
    )
    .orderBy(asc(gbpConfigs.nextCheckAt), asc(gbpConfigs.id))
    .limit(limit);
}

/**
 * Compare-and-set the schedule anchor so two overlapping cron ticks cannot
 * both run the same watch. Returns false when another writer moved it first.
 */
async function claimDueConfig(input: {
  configId: string;
  observedNextCheckAt: string;
  nextCheckAt: string;
}): Promise<boolean> {
  const claimed = await db
    .update(gbpConfigs)
    .set({ nextCheckAt: input.nextCheckAt })
    .where(
      and(
        eq(gbpConfigs.id, input.configId),
        eq(gbpConfigs.isActive, true),
        eq(gbpConfigs.nextCheckAt, input.observedNextCheckAt),
      ),
    )
    .returning({ id: gbpConfigs.id });
  return claimed.length > 0;
}

async function updateConfig(
  configId: string,
  values: Partial<
    Pick<GbpConfig, "lastCheckedAt" | "lastError" | "nextCheckAt">
  >,
): Promise<void> {
  await db.update(gbpConfigs).set(values).where(eq(gbpConfigs.id, configId));
}

async function insertSnapshot(row: GbpSnapshotInsert): Promise<void> {
  await db.insert(gbpSnapshots).values(row);
}

/** Newest-first stored snapshots for the project (never metered). */
async function listRecentSnapshots(
  projectId: string,
  limit: number,
): Promise<GbpSnapshotRow[]> {
  return db
    .select()
    .from(gbpSnapshots)
    .where(eq(gbpSnapshots.projectId, projectId))
    .orderBy(desc(gbpSnapshots.capturedAt), desc(gbpSnapshots.id))
    .limit(limit);
}

export const GbpWatchRepository = {
  getConfigForProject,
  upsertConfig,
  getDueConfigs,
  claimDueConfig,
  updateConfig,
  insertSnapshot,
  listRecentSnapshots,
};
