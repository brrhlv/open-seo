import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GbpConfig,
  GbpSnapshotRow,
} from "@/server/features/gbp-watch/repositories/GbpWatchRepository";
import profileFixture from "../__fixtures__/sblv-profile.json";
import reviewsFixture from "../__fixtures__/sblv-reviews.json";
import { GbpWatchService, nextWeeklyCheckAt } from "./GbpWatchService";

// The real service over an in-memory stand-in for the repository (the SQL
// itself is covered by GbpWatchRepository.test.ts against the migration).
// Only DataForSEO is mocked.

const mocks = vi.hoisted(() => ({
  configs: new Map<string, GbpConfig>(),
  snapshots: [] as GbpSnapshotRow[],
  business: {
    myBusinessInfo: vi.fn(),
    questionsAnswers: vi.fn(),
    reviewsTaskPost: vi.fn(),
    updatesTaskPost: vi.fn(),
  },
  fetchTask: vi.fn(),
  onCost: { current: undefined as ((usd: number) => void) | undefined },
  failConfigWrites: { current: false },
}));

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: (
    _customer: unknown,
    options: { onCost?: (usd: number) => void } = {},
  ) => {
    mocks.onCost.current = options.onCost;
    return { business: mocks.business };
  },
  fetchBusinessDataTaskResult: mocks.fetchTask,
}));

vi.mock("@/server/features/gbp-watch/repositories/GbpWatchRepository", () => ({
  GbpWatchRepository: {
    getConfigForProject: async (projectId: string) =>
      mocks.configs.get(projectId) ?? null,
    upsertConfig: async (
      values: Omit<
        GbpConfig,
        "id" | "lastCheckedAt" | "lastError" | "createdAt"
      >,
    ) => {
      const row = {
        id: "cfg-1",
        lastCheckedAt: null,
        lastError: null,
        createdAt: "2026-11-02 00:00:00",
        ...values,
      };
      mocks.configs.set(values.projectId, row);
      return row;
    },
    updateConfig: async (id: string, values: Partial<GbpConfig>) => {
      if (mocks.failConfigWrites.current) throw new Error("d1 write failed");
      for (const [key, config] of mocks.configs) {
        if (config.id === id) mocks.configs.set(key, { ...config, ...values });
      }
    },
    insertSnapshot: async (row: Omit<GbpSnapshotRow, "id">) => {
      mocks.snapshots.unshift({ id: mocks.snapshots.length + 1, ...row });
    },
    listRecentSnapshots: async (_projectId: string, limit: number) =>
      mocks.snapshots.slice(0, limit),
  },
}));

const PROJECT = "proj-1";
const billingCustomer = {
  organizationId: "org-1",
  userId: "system",
  userEmail: "system@openseo.so",
};
const market = { locationCode: 2840, languageCode: "en" };
const MON = new Date("2026-11-09T14:00:00Z");
const NEXT_MON = new Date("2026-11-16T14:00:00Z");

function charge(usd: number) {
  mocks.onCost.current?.(usd);
}

async function createWatch() {
  await GbpWatchService.setWatch({
    projectId: PROJECT,
    cid: "5590594803775798319",
    expected: {
      primaryCategory: "Photo booth",
      forbiddenCategories: ["Party equipment rental service"],
    },
    now: new Date("2026-11-02T12:00:00Z"),
  });
}

function run(now: Date, force = false) {
  return GbpWatchService.runSnapshot({
    projectId: PROJECT,
    billingCustomer,
    market,
    now,
    force,
    pollIntervalMs: 0,
  });
}

beforeEach(() => {
  mocks.failConfigWrites.current = false;
  mocks.configs.clear();
  mocks.snapshots.length = 0;
  mocks.business.myBusinessInfo.mockImplementation(async () => {
    charge(0.0054);
    return structuredClone(profileFixture);
  });
  mocks.business.questionsAnswers.mockImplementation(async () => {
    charge(0.0054);
    return [];
  });
  mocks.business.reviewsTaskPost.mockImplementation(async () => {
    charge(0.0015);
    return "reviews-task";
  });
  mocks.business.updatesTaskPost.mockImplementation(async () => {
    charge(0.0015);
    return "updates-task";
  });
  mocks.fetchTask.mockImplementation(
    async ({ endpoint }: { endpoint: string }) => ({
      status: "completed",
      result:
        endpoint === "reviews"
          ? { items: reviewsFixture.items.slice(1) }
          : { items: [] },
    }),
  );
});

describe("nextWeeklyCheckAt", () => {
  it("is the next Monday 14:00 UTC strictly after now", () => {
    expect(nextWeeklyCheckAt(new Date("2026-11-02T12:00:00Z"))).toBe(
      "2026-11-02T14:00:00.000Z",
    );
    expect(nextWeeklyCheckAt(MON)).toBe(NEXT_MON.toISOString());
    expect(nextWeeklyCheckAt(new Date("2026-11-08T23:00:00Z"))).toBe(
      MON.toISOString(),
    );
  });
});

describe("GbpWatchService", () => {
  it("rejects a watch without a cid or placeId", async () => {
    await expect(
      GbpWatchService.setWatch({ projectId: PROJECT }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("stores the first run as a baseline with its real cost and the live drift", async () => {
    await createWatch();
    const result = await run(MON);
    expect(result).toMatchObject({
      status: "checked",
      changes: 0,
      drift: 1,
      collected: { reviews: true, questions: true, updates: true },
    });
    expect(result.costUsd).toBeCloseTo(0.0138, 6);
    expect(mocks.business.questionsAnswers).toHaveBeenCalledWith(
      expect.objectContaining({
        keyword: "cid:5590594803775798319",
        locationCoordinate: "36.2108236,-115.2695665,1000",
      }),
    );

    const view = await GbpWatchService.getWatch(PROJECT, MON);
    expect(view.profile?.primaryCategory).toBe("Photo booth");
    expect(view.newReviewCount).toBe(0);
    expect(view.latestReviews).toHaveLength(5);
    expect(view.questionsAvailable).toBe(false);
    expect(view.driftFromExpected).toEqual([
      {
        field: "additionalCategories",
        rule: "forbidden_category",
        expected: "Not listed",
        actual: "Party equipment rental service",
        since: MON.toISOString(),
      },
    ]);
    expect(mocks.configs.get(PROJECT)?.lastCheckedAt).toBe(MON.toISOString());
  });

  it("skips DataForSEO for a re-run inside an hour unless forced", async () => {
    await createWatch();
    await run(MON);
    mocks.business.myBusinessInfo.mockClear();
    const soon = new Date(MON.getTime() + 10 * 60_000);
    expect((await run(soon)).status).toBe("already_captured");
    expect(mocks.business.myBusinessInfo).not.toHaveBeenCalled();
    expect((await run(soon, true)).status).toBe("checked");
  });

  it("diffs the next run against the previous one and keeps the drift's start", async () => {
    await createWatch();
    await run(MON);
    mocks.business.myBusinessInfo.mockResolvedValue({
      ...structuredClone(profileFixture),
      category: "Event planner",
      rating: { value: 4.9, votes_count: 114 },
    });
    mocks.fetchTask.mockImplementation(
      async ({ endpoint }: { endpoint: string }) => ({
        status: "completed",
        result:
          endpoint === "reviews"
            ? { items: reviewsFixture.items.slice(0, 5) }
            : { items: [] },
      }),
    );
    expect((await run(NEXT_MON)).changes).toBe(1);

    const view = await GbpWatchService.getWatch(PROJECT, NEXT_MON);
    expect(view.changes).toEqual([
      {
        field: "primaryCategory",
        from: "Photo booth",
        to: "Event planner",
        detectedAt: NEXT_MON.toISOString(),
      },
    ]);
    expect(view.rating).toMatchObject({
      value: 4.9,
      reviewCount: 114,
      previousValue: 5,
      previousReviewCount: 113,
      valueChange: -0.1,
      reviewCountChange: 1,
    });
    expect(view.newReviewCount).toBe(1);
    expect(view.latestReviews[0]).toMatchObject({
      author: "Reviewer A",
      isNew: true,
    });
    const party = view.driftFromExpected.find(
      (d) => d.rule === "forbidden_category",
    );
    expect(party?.since).toBe(MON.toISOString());
    expect(
      view.driftFromExpected.find((d) => d.rule === "primary_category")?.since,
    ).toBe(NEXT_MON.toISOString());
  });

  it("stores a run whose reviews task never settles, and the next run is not fooled by the gap", async () => {
    await createWatch();
    await run(MON);
    mocks.fetchTask.mockResolvedValue({ status: "pending", result: null });
    const gap = await run(NEXT_MON);
    expect(gap.collected).toEqual({
      reviews: false,
      questions: true,
      updates: false,
    });
    expect(mocks.snapshots[0]?.reviewsJson).toBeNull();
    const gapView = await GbpWatchService.getWatch(PROJECT, NEXT_MON);
    // Not "0 new": the latest check did not collect reviews.
    expect(gapView.newReviewCount).toBeNull();
    expect(gapView.latestReviews).toHaveLength(5);
    expect(gapView.latestReviews.some((r) => r.isNew)).toBe(false);

    mocks.fetchTask.mockResolvedValue({
      status: "completed",
      result: { items: reviewsFixture.items.slice(1) },
    });
    await run(new Date("2026-11-23T14:00:00Z"));
    expect((await GbpWatchService.getWatch(PROJECT)).newReviewCount).toBe(0);
  });

  it("stores nothing and records the error when Google returns no profile", async () => {
    await createWatch();
    mocks.business.myBusinessInfo.mockResolvedValue(null);
    await expect(run(MON)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(mocks.snapshots).toHaveLength(0);
    expect(mocks.configs.get(PROJECT)?.lastError).toContain("no profile");
    expect(mocks.business.reviewsTaskPost).not.toHaveBeenCalled();
  });

  it("keeps hours, claim status and categories DataForSEO leaves out, and reports no change", async () => {
    await createWatch();
    await run(MON);
    const omitted: Record<string, unknown> = structuredClone(profileFixture);
    delete omitted.work_time;
    delete omitted.is_claimed;
    omitted.additional_categories = null;
    mocks.business.myBusinessInfo.mockResolvedValue(omitted);
    expect((await run(NEXT_MON)).changes).toBe(0);
    expect(mocks.snapshots[0]).toMatchObject({
      isClaimed: true,
      hoursJson: mocks.snapshots[1]?.hoursJson,
      additionalCategoriesJson: mocks.snapshots[1]?.additionalCategoriesJson,
    });
  });

  it("starts a new baseline when the watch points at another profile", async () => {
    await createWatch();
    await run(MON);
    await GbpWatchService.setWatch({ projectId: PROJECT, cid: "123" });
    mocks.business.myBusinessInfo.mockResolvedValue({
      ...structuredClone(profileFixture),
      title: "Another business",
      category: "Event planner",
    });
    mocks.fetchTask.mockImplementation(
      async ({ endpoint }: { endpoint: string }) => ({
        status: "completed",
        result:
          endpoint === "reviews"
            ? { items: reviewsFixture.items.slice(0, 5) }
            : { items: [] },
      }),
    );
    expect((await run(NEXT_MON)).changes).toBe(0);
    expect(mocks.snapshots[0]?.identifier).toBe("cid:123");

    const view = await GbpWatchService.getWatch(PROJECT, NEXT_MON);
    expect(view.newReviewCount).toBe(0);
    expect(view.rating.previousValue).toBeNull();
    expect(view.driftFromExpected[0]?.since).toBe(NEXT_MON.toISOString());
  });

  it("keeps a saved snapshot when only the config write after it fails", async () => {
    await createWatch();
    mocks.failConfigWrites.current = true;
    expect((await run(MON)).status).toBe("checked");
    expect(mocks.snapshots).toHaveLength(1);
  });

  it("reads an untracked project as empty", async () => {
    const view = await GbpWatchService.getWatch(PROJECT, MON);
    expect(view).toMatchObject({
      tracked: false,
      profile: null,
      latestReviews: [],
      changes: [],
      driftFromExpected: [],
      ownerUpdates: null,
      expected: null,
    });
  });
});
