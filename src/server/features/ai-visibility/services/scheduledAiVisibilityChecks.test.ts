import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as AiVisibilityServiceModule from "./AiVisibilityService";
import type * as SchedulerModule from "./scheduledAiVisibilityChecks";

// Real due query + compare-and-set over in-memory SQLite built from the
// shipped migration; only the paid run itself (runCheck) is mocked.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: vi.fn(),
}));

type RunCheckInput = {
  projectId: string;
  billingCustomer: { organizationId: string };
};
const mocks = vi.hoisted(() => ({
  runCheck: vi.fn<(input: RunCheckInput) => Promise<unknown>>(),
}));

vi.mock(
  "@/server/features/ai-visibility/services/AiVisibilityService",
  async (importOriginal) => {
    const actual = await importOriginal<typeof AiVisibilityServiceModule>();
    return {
      ...actual,
      AiVisibilityService: {
        ...actual.AiVisibilityService,
        runCheck: mocks.runCheck,
      },
    };
  },
);

const NOW = new Date("2026-10-01T06:02:00Z");

let client: Client;
let Scheduler: typeof SchedulerModule;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  const migration = readFileSync("drizzle/0045_ai_visibility.sql", "utf8");
  await client.executeMultiple(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
      domain TEXT, archived_at TEXT
    );
    ${migration.replaceAll("--> statement-breakpoint", "")}
  `);
  // Dynamic import after doMock so the repository binds to the test DB.
  Scheduler = await import("./scheduledAiVisibilityChecks");

  // The service import graph is large; allow for a cold transform cache.
}, 30_000);

afterAll(() => client.close());

function config(
  id: string,
  overrides: {
    nextCheckAt?: string | null;
    schedule?: string;
    active?: number;
    archived?: boolean;
  } = {},
) {
  const next =
    overrides.nextCheckAt === undefined
      ? "'2026-10-01T06:00:00.000Z'"
      : overrides.nextCheckAt === null
        ? "NULL"
        : `'${overrides.nextCheckAt}'`;
  return `
    INSERT INTO projects (id, organization_id, name, archived_at)
      VALUES ('p-${id}', 'org-1', '${id}', ${overrides.archived ? "'2026-09-01'" : "NULL"});
    INSERT INTO ai_visibility_configs (id, project_id, target, schedule_interval, is_active, next_check_at)
      VALUES ('${id}', 'p-${id}', '${id}.com', '${overrides.schedule ?? "monthly"}', ${overrides.active ?? 1}, ${next});
  `;
}

async function nextCheckAt(id: string) {
  const result = await client.execute({
    sql: "SELECT next_check_at, last_error FROM ai_visibility_configs WHERE id = ?",
    args: [id],
  });
  return result.rows[0];
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.runCheck.mockResolvedValue({
    status: "checked",
    period: "2026-10",
    costUsd: 0.8,
    platforms: ["chat_gpt", "google"],
  });
  await client.executeMultiple(`
    DELETE FROM ai_visibility_configs;
    DELETE FROM projects;
  `);
});

describe("runScheduledAiVisibilityChecks", () => {
  it("runs only active, monthly, due configs of live projects and moves them to next month's 1st", async () => {
    await client.executeMultiple(
      config("due") +
        config("future", { nextCheckAt: "2026-11-01T06:00:00.000Z" }) +
        config("manual", { schedule: "manual" }) +
        config("paused", { active: 0 }) +
        config("archived", { archived: true }) +
        config("unscheduled", { nextCheckAt: null }),
    );

    await Scheduler.runScheduledAiVisibilityChecks(NOW);

    expect(mocks.runCheck).toHaveBeenCalledTimes(1);
    const [input] = mocks.runCheck.mock.calls[0] ?? [];
    expect(input?.projectId).toBe("p-due");
    expect(input?.billingCustomer.organizationId).toBe("org-1");
    expect(await nextCheckAt("due")).toMatchObject({
      next_check_at: "2026-11-01T06:00:00.000Z",
      last_error: null,
    });
  });

  it("caps runs per tick, oldest first, leaving the rest due for the next tick", async () => {
    await client.executeMultiple(
      config("c", { nextCheckAt: "2026-10-01T05:00:00.000Z" }) +
        config("a", { nextCheckAt: "2026-10-01T03:00:00.000Z" }) +
        config("b", { nextCheckAt: "2026-10-01T04:00:00.000Z" }),
    );

    await Scheduler.runScheduledAiVisibilityChecks(NOW);

    expect(mocks.runCheck.mock.calls.map(([input]) => input.projectId)).toEqual(
      ["p-a", "p-b"],
    );
    expect(await nextCheckAt("c")).toMatchObject({
      next_check_at: "2026-10-01T05:00:00.000Z",
    });
  });

  it("records a failed run and retries it in six hours, not next month", async () => {
    await client.executeMultiple(config("due"));
    mocks.runCheck.mockRejectedValue(new Error("DataForSEO down"));

    await Scheduler.runScheduledAiVisibilityChecks(NOW);

    expect(await nextCheckAt("due")).toMatchObject({
      next_check_at: "2026-10-01T12:02:00.000Z",
      last_error: "DataForSEO down",
    });
  });
});
