import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as GbpWatchServiceModule from "@/server/features/gbp-watch/services/GbpWatchService";
import { runScheduledGbpSnapshots } from "./scheduledGbpSnapshots";

const mocks = vi.hoisted(() => ({
  getDueConfigs: vi.fn(),
  claimDueConfig: vi.fn(),
  updateConfig: vi.fn(),
  runSnapshot: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/server/features/gbp-watch/repositories/GbpWatchRepository", () => ({
  GbpWatchRepository: {
    getDueConfigs: mocks.getDueConfigs,
    claimDueConfig: mocks.claimDueConfig,
    updateConfig: mocks.updateConfig,
  },
}));
vi.mock(
  "@/server/features/gbp-watch/services/GbpWatchService",
  async (importOriginal) => ({
    ...(await importOriginal<typeof GbpWatchServiceModule>()),
    GbpWatchService: { runSnapshot: mocks.runSnapshot },
  }),
);

const NOW = new Date("2026-11-09T14:00:00Z");
const due = {
  id: "cfg-1",
  projectId: "proj-1",
  nextCheckAt: "2026-11-09T14:00:00.000Z",
  organizationId: "org-1",
  locationCode: 2840,
  languageCode: "en",
};

describe("runScheduledGbpSnapshots", () => {
  beforeEach(() => {
    mocks.getDueConfigs.mockResolvedValue([due]);
    mocks.claimDueConfig.mockResolvedValue(true);
    mocks.runSnapshot.mockResolvedValue({ status: "checked", costUsd: 0.014 });
    mocks.updateConfig.mockResolvedValue(undefined);
  });

  it("claims one due watch for next Monday and runs it in the project's market", async () => {
    await runScheduledGbpSnapshots(NOW);
    expect(mocks.getDueConfigs).toHaveBeenCalledWith(NOW.toISOString(), 1);
    expect(mocks.claimDueConfig).toHaveBeenCalledWith({
      configId: "cfg-1",
      observedNextCheckAt: due.nextCheckAt,
      nextCheckAt: "2026-11-16T14:00:00.000Z",
    });
    expect(mocks.runSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        market: { locationCode: 2840, languageCode: "en" },
        force: true,
      }),
    );
  });

  it("skips a watch another tick already claimed", async () => {
    mocks.claimDueConfig.mockResolvedValue(false);
    await runScheduledGbpSnapshots(NOW);
    expect(mocks.runSnapshot).not.toHaveBeenCalled();
  });

  it("retries a failed run in 6 hours", async () => {
    mocks.runSnapshot.mockRejectedValue(new Error("DataForSEO down"));
    await runScheduledGbpSnapshots(NOW);
    expect(mocks.updateConfig).toHaveBeenCalledWith("cfg-1", {
      nextCheckAt: "2026-11-09T20:00:00.000Z",
    });
  });
});
