import { readFileSync } from "node:fs";
import { z } from "zod";
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
import type * as ServiceModule from "./AiVisibilityPromptService";

// Real service + repository over in-memory SQLite built from the shipped
// migrations. Only DataForSEO is mocked; it answers with real SBLV fixtures.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: (promise: Promise<unknown>) => void promise.catch(() => {}),
}));

const FIXTURES = z
  .record(z.string(), z.unknown())
  .parse(
    JSON.parse(
      readFileSync(
        "src/server/features/ai-visibility/services/__fixtures__/prompt-answers.json",
        "utf8",
      ),
    ),
  );

const mocks = vi.hoisted(() => ({
  onCost: { current: undefined as ((usd: number) => void) | undefined },
  aiSearch: {
    chatGptScraper: vi.fn(),
    googleAiMode: vi.fn(),
    llmResponse: vi.fn(),
  },
}));

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: (
    _customer: unknown,
    options: { onCost?: (usd: number) => void } = {},
  ) => {
    const onCost = options.onCost;
    const charged =
      (fn: (input: unknown) => Promise<unknown>, usd: number) =>
      async (input: unknown) => {
        onCost?.(usd);
        return fn(input);
      };
    return {
      aiSearch: {
        chatGptScraper: charged(mocks.aiSearch.chatGptScraper, 0.004),
        googleAiMode: charged(mocks.aiSearch.googleAiMode, 0.004),
        llmResponse: charged(mocks.aiSearch.llmResponse, 0.006),
      },
    };
  },
}));

const PROJECT = "proj-1";
const billingCustomer = {
  organizationId: "org-1",
  userId: "system",
  userEmail: "system@openseo.so",
};
const NOV = new Date("2026-11-03T07:00:00Z");
const DEC = new Date("2026-12-01T06:30:00Z");

let client: Client;
let Service: typeof ServiceModule;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  const migrations = [
    "drizzle/0045_ai_visibility.sql",
    "drizzle/0049_ai_visibility_prompts.sql",
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
  // Dynamic import after doMock so the repositories bind to the test DB.
  Service = await import("./AiVisibilityPromptService");
}, 30_000);

afterAll(() => client.close());

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM ai_visibility_prompt_results;
    DELETE FROM ai_visibility_prompts;
    DELETE FROM ai_visibility_configs;
    DELETE FROM project_competitors;
    DELETE FROM projects;
    INSERT INTO projects (id, organization_id, name, domain)
      VALUES ('${PROJECT}', 'org-1', 'SBLV', 'socialboothlv.com');
    INSERT INTO project_competitors (id, project_id, domain, name, updated_by)
      VALUES ('c1', '${PROJECT}', 'boothmeuplv.com', 'Booth Me Up LV', 'mcp');
    INSERT INTO ai_visibility_configs (id, project_id, target, next_check_at)
      VALUES ('cfg-1', '${PROJECT}', 'socialboothlv.com', '2026-12-01T06:00:00.000Z');
  `);
  mocks.aiSearch.chatGptScraper.mockResolvedValue(FIXTURES.chat_gpt_1);
  mocks.aiSearch.googleAiMode.mockResolvedValue(FIXTURES.google_ai_mode_1);
  mocks.aiSearch.llmResponse.mockResolvedValue(FIXTURES.perplexity_1);
});

function service() {
  return Service.AiVisibilityPromptService;
}

async function resultRows() {
  const result = await client.execute(
    "SELECT platform, period, status, mentioned, position, cited_url, attempts, cost_usd, error FROM ai_visibility_prompt_results ORDER BY period, platform",
  );
  return result.rows;
}

const PROMPT = "best photo booth company for a corporate event in Las Vegas";

async function addOne(): Promise<string> {
  const added = await service().addPrompts({
    projectId: PROJECT,
    prompts: [PROMPT],
    now: NOV,
  });
  return added.prompts[0]?.id ?? "";
}

const run = (now: Date, extra: { force?: boolean } = {}) =>
  service().runPrompts({
    projectId: PROJECT,
    projectDomain: "socialboothlv.com",
    billingCustomer,
    now,
    ...extra,
  });

describe("AiVisibilityPromptService prompts", () => {
  it("adds normalized, deduped prompts that wait for the monthly check, and reactivates a removed one", async () => {
    const first = await service().addPrompts({
      projectId: PROJECT,
      prompts: [
        "  best  photo booth  ",
        "best photo booth",
        "trade show booth",
      ],
      now: NOV,
    });
    expect(first).toMatchObject({ added: 2, reactivated: 0 });
    expect(first.prompts.map((p) => p.prompt)).toEqual([
      "best photo booth",
      "trade show booth",
    ]);
    expect(first.prompts[0]).toMatchObject({
      platforms: ["chat_gpt", "google_ai_mode", "perplexity"],
      // The tracker's next monthly check, not now (Bryan, 2026-11-03).
      nextRunAt: "2026-12-01T06:00:00.000Z",
    });

    const id = first.prompts[0]?.id ?? "";
    expect(await service().removePrompts(PROJECT, [id])).toEqual({
      removed: 1,
    });
    const again = await service().addPrompts({
      projectId: PROJECT,
      prompts: ["best photo booth"],
      platforms: ["chat_gpt"],
      now: DEC,
    });
    expect(again).toMatchObject({ added: 0, reactivated: 1 });
    expect(again.prompts.find((p) => p.id === id)).toMatchObject({
      platforms: ["chat_gpt"],
      // Reactivated on the 1st: joins that day's monthly run.
      nextRunAt: "2026-12-01T06:00:00.000Z",
    });
  });

  it("without a monthly tracker, or during its mid-month retry, waits for the next 1st", async () => {
    await client.execute(
      "UPDATE ai_visibility_configs SET next_check_at = '2026-11-03T13:00:00.000Z'",
    );
    const retrying = await service().addPrompts({
      projectId: PROJECT,
      prompts: ["first prompt"],
      now: NOV,
    });
    expect(retrying.prompts[0]?.nextRunAt).toBe("2026-12-01T06:00:00.000Z");
    await client.execute("DELETE FROM ai_visibility_configs");
    const none = await service().addPrompts({
      projectId: PROJECT,
      prompts: ["second prompt"],
      now: NOV,
    });
    expect(none.prompts[1]?.nextRunAt).toBe("2026-12-01T06:00:00.000Z");
  });

  it("caps a project at 10 active prompts", async () => {
    await expect(
      service().addPrompts({
        projectId: PROJECT,
        prompts: Array.from({ length: 11 }, (_, i) => `prompt number ${i}`),
      }),
    ).rejects.toThrow(/at most 10/);
  });
});

describe("AiVisibilityPromptService runs", () => {
  it("stores one row per platform with mention, position, cited page and cost", async () => {
    await service().addPrompts({
      projectId: PROJECT,
      prompts: ["best photo booth company for a corporate event in Las Vegas"],
      now: NOV,
    });
    const result = await run(NOV);
    expect(result.period).toBe("2026-11");
    expect(result.costUsd).toBeCloseTo(0.014);
    expect(await resultRows()).toMatchObject([
      {
        platform: "chat_gpt",
        status: "ok",
        mentioned: 1,
        position: 1,
        cited_url: "https://socialboothlv.com/corporate-events",
      },
      { platform: "google_ai_mode", status: "ok", position: 1 },
      { platform: "perplexity", status: "ok", mentioned: 0, position: null },
    ]);
  });

  it("records a failed platform, retries only it, and never loses a good answer", async () => {
    await service().addPrompts({
      projectId: PROJECT,
      prompts: ["best photo booth company for a corporate event in Las Vegas"],
      now: NOV,
    });
    mocks.aiSearch.llmResponse.mockRejectedValueOnce(new Error("upstream"));
    const first = await run(NOV);
    expect(first.outcomes[0]).toMatchObject({
      failed: ["perplexity"],
      retry: true,
    });

    const second = await run(NOV);
    expect(second.outcomes[0]).toMatchObject({
      ran: ["perplexity"],
      skipped: ["chat_gpt", "google_ai_mode"],
    });

    // A forced re-run where ChatGPT fails keeps November's ok row.
    mocks.aiSearch.chatGptScraper.mockRejectedValueOnce(new Error("timeout"));
    await run(NOV, { force: true });
    const chatGpt = (await resultRows()).find((r) => r.platform === "chat_gpt");
    expect(chatGpt).toMatchObject({
      status: "ok",
      position: 1,
      attempts: 2,
      error: null,
    });
    expect(Number(chatGpt?.cost_usd)).toBeCloseTo(0.008);
  });

  it("records a timed-out ChatGPT call at its estimated cost (DataForSEO still bills it)", async () => {
    await addOne();
    const timeout = Object.assign(new Error("DataForSEO request timed out"), {
      name: "DataForSEOTimeoutError",
    });
    mocks.aiSearch.chatGptScraper.mockImplementationOnce(async () => {
      throw timeout;
    });
    await run(NOV);
    const chatGpt = (await resultRows()).find((r) => r.platform === "chat_gpt");
    expect(chatGpt).toMatchObject({ status: "error", attempts: 1 });
    expect(Number(chatGpt?.cost_usd)).toBeCloseTo(0.004);
  });

  it("stops at 3 attempts per platform a month, force and re-adding included", async () => {
    const id = await addOne();
    await run(NOV);
    await run(NOV, { force: true });
    await run(NOV, { force: true });
    await service().removePrompts(PROJECT, [id]);
    await service().addPrompts({
      projectId: PROJECT,
      prompts: [PROMPT],
      now: NOV,
    });
    const fourth = await run(NOV, { force: true });
    expect(fourth.outcomes[0]).toMatchObject({
      ran: [],
      skipped: ["chat_gpt", "google_ai_mode", "perplexity"],
      costUsd: 0,
    });
    expect(mocks.aiSearch.chatGptScraper).toHaveBeenCalledTimes(3);
  });

  it("concurrent run-now calls run a prompt once (the second finds it leased)", async () => {
    await addOne();
    const [a, b] = await Promise.all([run(NOV), run(NOV)]);
    expect(mocks.aiSearch.chatGptScraper).toHaveBeenCalledOnce();
    expect([...a.skipped, ...b.skipped]).toEqual([
      expect.objectContaining({ reason: "busy" }),
    ]);
  });

  it("runs at most two prompts at a time", async () => {
    await service().addPrompts({
      projectId: PROJECT,
      prompts: [
        "one prompt",
        "two prompt",
        "three prompt",
        "four prompt",
        "five prompt",
      ],
      now: NOV,
    });
    let inFlight = 0;
    let peak = 0;
    mocks.aiSearch.chatGptScraper.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return FIXTURES.chat_gpt_1;
    });
    const result = await run(NOV);
    expect(result.outcomes).toHaveLength(5);
    expect(peak).toBe(2);
  });

  it("refuses once this month's spend reaches the $1.00 cap", async () => {
    await addOne();
    await run(NOV);
    await client.execute(
      "UPDATE ai_visibility_prompt_results SET cost_usd = 0.5",
    );
    await expect(run(NOV, { force: true })).rejects.toThrow(/monthly cap/);
  });

  it("removing and adding can't run more than 10 prompts in a month", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `prompt number ${i}`);
    const added = await service().addPrompts({
      projectId: PROJECT,
      prompts: ten,
      now: NOV,
    });
    await run(NOV);
    await service().removePrompts(
      PROJECT,
      added.prompts.map((p) => p.id),
    );
    await service().addPrompts({
      projectId: PROJECT,
      prompts: ["prompt eleven"],
      now: NOV,
    });
    const calls = mocks.aiSearch.chatGptScraper.mock.calls.length;
    const result = await run(NOV);
    expect(result.skipped).toEqual([
      expect.objectContaining({ reason: "monthly_prompt_limit" }),
    ]);
    expect(mocks.aiSearch.chatGptScraper.mock.calls.length).toBe(calls);
    const row = await client.execute(
      "SELECT next_run_at FROM ai_visibility_prompts WHERE prompt = 'prompt eleven'",
    );
    expect(row.rows[0]?.next_run_at).toBe("2026-12-01T06:00:00.000Z");
  });

  it("refuses without an AI visibility tracker", async () => {
    await client.execute("DELETE FROM ai_visibility_configs");
    await expect(run(NOV)).rejects.toThrow(/No AI visibility tracker/);
  });
});

describe("AiVisibilityPromptService.getResults", () => {
  it("returns the latest run per platform with the previous month", async () => {
    await service().addPrompts({
      projectId: PROJECT,
      prompts: ["best photo booth company for a corporate event in Las Vegas"],
      now: NOV,
    });
    await run(NOV);
    mocks.aiSearch.chatGptScraper.mockResolvedValue(FIXTURES.chat_gpt_2);
    await run(DEC);

    const results = await service().getResults(PROJECT);
    expect(results.schedule).toBe("monthly");
    expect(results.lastRunAt).toBe(DEC.toISOString());
    const chatGpt = results.items[0]?.results.find(
      (r) => r.platform === "chat_gpt",
    );
    expect(chatGpt).toMatchObject({
      latest: { period: "2026-12", position: 2 },
      previous: { period: "2026-11", position: 1 },
    });
    expect(chatGpt?.latest.competitors).toEqual([]);
    expect(results.items[0]?.results.map((r) => r.platform)).toEqual([
      "chat_gpt",
      "google_ai_mode",
      "perplexity",
    ]);
  });
});
