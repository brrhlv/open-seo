import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
} from "drizzle-kit/api";
import {
  localGridCells,
  localGridConfigs,
  localGridKeywords,
  localGridSnapshots,
} from "@/db/local-grid.schema";

/**
 * In-memory SQLite with the local-grid tables, built from the Drizzle schema
 * itself (not a numbered migration file, which the wave coordinator may
 * renumber) plus a minimal projects table. For tests only.
 */
export async function createLocalGridTestDb(): Promise<{
  client: Client;
  db: ReturnType<typeof drizzle>;
}> {
  const client = createClient({ url: "file::memory:" });
  const statements = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson({
      localGridConfigs,
      localGridKeywords,
      localGridSnapshots,
      localGridCells,
    }),
  );
  await client.executeMultiple(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
      domain TEXT, archived_at TEXT
    );
    ${statements.map((s) => `${s.replace(/;\s*$/, "")};`).join("\n")}
  `);
  return { client, db: drizzle(client) };
}
