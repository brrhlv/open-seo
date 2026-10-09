import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { backlinkSnapshots } from "@/db/schema";

type BacklinkSnapshot = typeof backlinkSnapshots.$inferSelect;

async function getLatestForProject(
  projectId: string,
): Promise<BacklinkSnapshot | null> {
  const rows = await db
    .select()
    .from(backlinkSnapshots)
    .where(eq(backlinkSnapshots.projectId, projectId))
    // id, not capturedAt: autoincrement is monotonic and immune to the
    // sqlite-vs-pg timestamp text-format difference.
    .orderBy(desc(backlinkSnapshots.id))
    .limit(1);
  return rows[0] ?? null;
}

/** Newest-first stored snapshots for the project (D1 only, never metered). */
async function listRecentForProject(
  projectId: string,
  limit: number,
): Promise<BacklinkSnapshot[]> {
  return db
    .select()
    .from(backlinkSnapshots)
    .where(eq(backlinkSnapshots.projectId, projectId))
    .orderBy(desc(backlinkSnapshots.id))
    .limit(limit);
}

async function insert(
  values: typeof backlinkSnapshots.$inferInsert,
): Promise<BacklinkSnapshot> {
  const [row] = await db.insert(backlinkSnapshots).values(values).returning();
  if (!row) {
    throw new Error("Failed to insert backlink_snapshot");
  }
  return row;
}

async function updateById(
  id: number,
  values: Partial<
    Omit<typeof backlinkSnapshots.$inferInsert, "id" | "projectId">
  >,
): Promise<void> {
  await db
    .update(backlinkSnapshots)
    .set(values)
    .where(eq(backlinkSnapshots.id, id));
}

export const BacklinkSnapshotRepository = {
  getLatestForProject,
  listRecentForProject,
  insert,
  updateById,
};
