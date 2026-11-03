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

// The PAI-255 prompt phase of the AI visibility cron, over in-memory SQLite
// built from the shipped migrations. DataForSEO answers with real fixtures;
// the mentions run (runCheck) is mocked.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: vi.fn(),
}));

const FIXTURES: Record<string, unknown> = JSON.parse(
  readFileSync(
    "src/server/features/ai-visibility/services/__fixtures__/prompt-answers.json",
    "utf8",
  ),
);

const mocks = vi.hoisted(() => ({
  runCheck: vi.fn(),
  chatGptScraper: vi.fn(),
  googleAiMode: vi.fn(),
  llmResponse: vi.fn(),
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

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({
    aiSearch: {
      chatGptScraper: mocks.chatGptScraper,
      googleAiMode: mocks.googleAiMode,
      llmResponse: mocks.llmResponse,
    },
  }),
}));

const NOW = new Date("2026-12-01T06:40:00Z");
const DUE = "2026-12-01T06:00:00.000Z";

let client: Client;
let Scheduler: typeof SchedulerModule;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  const migrations = [
    "drizzle/0045_ai_visibility.sql",
    "drizzle/0046_ai_visibility_prompts.sql",
  ]
    .map((path) =>
      readFileSync(path, "utf8").replaceAll("--> statement-breakpoint", ""),
    )
    .join("\n");
  await client.executeMultiple(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
      domain TEXT, archived_at TEXT
    );
    CREATE TABLE project_competitors (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, domain TEXT NOT NULL,
      name TEXT, notes TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT NOT NULL
    );
    ${migrations}
  `);
  Scheduler = await import("./scheduledAiVisibilityChecks");
}, 30_000);

afterAll(() => client.close());

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM ai_visibility_prompt_results;
    DELETE FROM ai_visibility_prompts;
    DELETE FROM ai_visibility_configs;
    DELETE FROM projects;
    INSERT INTO projects (id, organization_id, name, domain)
      VALUES ('p1', 'org-1', 'SBLV', 'socialboothlv.com');
    INSERT INTO ai_visibility_configs (id, project_id, target, next_check_at)
      VALUES ('cfg-1', 'p1', 'socialboothlv.com', '2027-01-01T06:00:00.000Z');
    INSERT INTO ai_visibility_prompts (id, project_id, prompt, next_run_at)
      VALUES ('q1', 'p1', 'best photo booth company for a corporate event in Las Vegas', '${DUE}');
  `);
  mocks.chatGptScraper.mockResolvedValue(FIXTURES.chat_gpt_1);
  mocks.googleAiMode.mockResolvedValue(FIXTURES.google_ai_mode_1);
  mocks.llmResponse.mockResolvedValue(FIXTURES.perplexity_1);
});

async function prompt() {
  const result = await client.execute(
    "SELECT next_run_at, last_error FROM ai_visibility_prompts WHERE id = 'q1'",
  );
  return result.rows[0];
}

async function resultCount() {
  const result = await client.execute(
    "SELECT COUNT(*) AS n FROM ai_visibility_prompt_results WHERE status = 'ok'",
  );
  return Number(result.rows[0]?.n);
}

describe("buyer prompt phase of the AI visibility cron", () => {
  it("waits while a mentions tracker is due, then runs and reschedules monthly", async () => {
    await client.execute(
      `UPDATE ai_visibility_configs SET next_check_at = '${DUE}'`,
    );
    mocks.runCheck.mockResolvedValue({ status: "checked", costUsd: 0 });
    await Scheduler.runScheduledAiVisibilityChecks(NOW);
    expect(mocks.runCheck).toHaveBeenCalledOnce();
    expect(mocks.chatGptScraper).not.toHaveBeenCalled();

    // The tracker was claimed (moved to January), so the next tick runs prompts.
    await Scheduler.runScheduledAiVisibilityChecks(NOW);
    expect(await resultCount()).toBe(3);
    expect(await prompt()).toMatchObject({
      next_run_at: "2027-01-01T06:00:00.000Z",
      last_error: null,
    });
  });

  it("retries a failed platform after 6 hours, at most 3 attempts a month", async () => {
    mocks.llmResponse.mockRejectedValue(new Error("upstream"));
    const sixHoursLater = "2026-12-01T12:40:00.000Z";

    await Scheduler.runScheduledAiVisibilityChecks(NOW);
    expect(await prompt()).toMatchObject({ next_run_at: sixHoursLater });

    await Scheduler.runScheduledAiVisibilityChecks(new Date(sixHoursLater));
    await Scheduler.runScheduledAiVisibilityChecks(
      new Date("2026-12-01T18:40:00.000Z"),
    );
    // Third failed attempt: no more retries this month.
    expect(await prompt()).toMatchObject({
      next_run_at: "2027-01-01T06:00:00.000Z",
    });
    expect(mocks.llmResponse).toHaveBeenCalledTimes(3);
    expect(mocks.chatGptScraper).toHaveBeenCalledOnce();
  });

  it("waits for the next tick when the rank loop used most of this one", async () => {
    await Scheduler.runScheduledAiVisibilityChecks(NOW, Date.now() - 61_000);
    expect(mocks.chatGptScraper).not.toHaveBeenCalled();
    expect(await prompt()).toMatchObject({ next_run_at: DUE });
  });

  it("a run that throws counts as an attempt on every open platform", async () => {
    // The results table rejects writes: the whole run throws inside the lease.
    await client.execute(
      "CREATE TRIGGER no_results BEFORE INSERT ON ai_visibility_prompt_results WHEN NEW.status = 'ok' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    try {
      await Scheduler.runScheduledAiVisibilityChecks(NOW);
      await Scheduler.runScheduledAiVisibilityChecks(
        new Date("2026-12-01T12:40:00.000Z"),
      );
      await Scheduler.runScheduledAiVisibilityChecks(
        new Date("2026-12-01T18:40:00.000Z"),
      );
      const rows = await client.execute(
        "SELECT platform, status, attempts FROM ai_visibility_prompt_results ORDER BY platform",
      );
      expect(rows.rows.map((r) => [r.status, r.attempts])).toEqual([
        ["error", 3],
        ["error", 3],
        ["error", 3],
      ]);
      expect(await prompt()).toMatchObject({
        next_run_at: "2027-01-01T06:00:00.000Z",
      });
    } finally {
      await client.execute("DROP TRIGGER no_results");
    }
  });

  it("skips projects whose tracker is manual or paused", async () => {
    await client.execute(
      "UPDATE ai_visibility_configs SET schedule_interval = 'manual'",
    );
    await Scheduler.runScheduledAiVisibilityChecks(NOW);
    expect(mocks.chatGptScraper).not.toHaveBeenCalled();
    expect(await prompt()).toMatchObject({ next_run_at: DUE });
  });
});
