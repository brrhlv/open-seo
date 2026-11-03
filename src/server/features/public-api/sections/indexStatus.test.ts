import { beforeEach, describe, expect, it, vi } from "vitest";
import { getIndexStatusSection } from "./indexStatus";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  listKeyPages: vi.fn(),
  listForProject: vi.fn(),
  isHosted: vi.fn(),
}));
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: { getByProjectId: mocks.getConnection },
}));
vi.mock(
  "@/server/features/project-context/repositories/ProjectContextRepository",
  () => ({ ProjectContextRepository: { listKeyPages: mocks.listKeyPages } }),
);
vi.mock("@/server/features/gsc/repositories/UrlInspectionRepository", () => ({
  UrlInspectionRepository: { listForProject: mocks.listForProject },
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: mocks.isHosted,
}));

function row(url: string, fields: Record<string, string | null>) {
  return {
    url,
    inspectedUrl: url,
    verdict: null,
    googleCanonical: null,
    userCanonical: null,
    error: null,
    inspectedAt: "2026-11-02T10:00:00.000Z",
    attemptedAt: "2026-11-02T10:00:00.000Z",
    nextCheckAt: "2026-11-03T10:00:00.000Z",
    ...fields,
  };
}

describe("getIndexStatusSection", () => {
  beforeEach(() => {
    mocks.isHosted.mockResolvedValue(false);
    mocks.getConnection.mockResolvedValue({ siteUrl: "sc-domain:a.com" });
    mocks.listKeyPages.mockResolvedValue(
      ["f", "e", "d", "a", "b", "c"].map((p) => ({
        url: `https://a.com/${p}`,
      })),
    );
    mocks.listForProject.mockResolvedValue([
      row("https://a.com/a", {
        verdict: "PASS",
        googleCanonical: "https://a.com/a",
        userCanonical: "https://a.com/a",
        inspectedAt: "2026-11-01T09:00:00.000Z",
        nextCheckAt: "2026-11-02T09:00:00.000Z",
      }),
      row("https://a.com/b", {
        verdict: "NEUTRAL",
        coverageState: "Crawled - currently not indexed",
        googleCanonical: "https://a.com/",
        userCanonical: "https://a.com/b",
      }),
      // Never succeeded, last check failed.
      row("https://a.com/c", { error: "URL unknown", inspectedAt: null }),
      // Last check failed, the previous result stays.
      row("https://a.com/d", {
        verdict: "PASS",
        error: "Rate limit",
        attemptedAt: "2026-11-02T11:00:00.000Z",
      }),
      // A result without a verdict and without an error.
      row("https://a.com/e", {}),
      // Leased by the cron, not checked yet.
      row("https://a.com/f", { inspectedAt: null }),
      // A row for a page that is no longer a key page is ignored.
      row("https://a.com/old", { verdict: "PASS" }),
    ]);
  });

  it("maps each key page to a state, keeps the last verdict through a failed check, and counts", async () => {
    const section = await getIndexStatusSection("p");
    expect(section).toMatchObject({
      connected: true,
      capturedAt: "2026-11-02T10:00:00.000Z",
      nextCheckAfter: "2026-11-02T09:00:00.000Z",
      counts: { indexed: 2, notIndexed: 1, failed: 2, pending: 1 },
    });
    if (!section.connected) throw new Error("expected connected");
    expect(
      section.pages.map((p) => [p.url, p.state, p.canonicalMismatch]),
    ).toEqual([
      ["https://a.com/a", "indexed", false],
      ["https://a.com/b", "not_indexed", true],
      ["https://a.com/c", "failed", false],
      ["https://a.com/d", "indexed", false],
      ["https://a.com/e", "failed", false],
      ["https://a.com/f", "pending", false],
    ]);
    expect(section.pages[3]).toMatchObject({
      error: "Rate limit",
      inspectedAt: "2026-11-02T10:00:00.000Z",
      checkedAt: "2026-11-02T11:00:00.000Z",
    });
  });

  it("is connected:false without a Search Console property, or in hosted mode", async () => {
    mocks.getConnection.mockResolvedValueOnce(null);
    expect(await getIndexStatusSection("p")).toEqual({ connected: false });
    mocks.isHosted.mockResolvedValue(true);
    expect(await getIndexStatusSection("p")).toEqual({ connected: false });
  });

  it("has no stamps before the first run", async () => {
    mocks.listForProject.mockResolvedValue([]);
    expect(await getIndexStatusSection("p")).toMatchObject({
      capturedAt: null,
      nextCheckAfter: null,
      counts: { pending: 6 },
    });
  });
});
