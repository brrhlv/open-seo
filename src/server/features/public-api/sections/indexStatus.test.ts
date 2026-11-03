import { beforeEach, describe, expect, it, vi } from "vitest";
import { getIndexStatusSection } from "./indexStatus";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  listKeyPages: vi.fn(),
  listForProject: vi.fn(),
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

function row(url: string, fields: Record<string, string | null>) {
  return {
    url,
    inspectedUrl: url,
    verdict: null,
    googleCanonical: null,
    userCanonical: null,
    error: null,
    inspectedAt: "2026-11-02T10:00:00.000Z",
    ...fields,
  };
}

describe("getIndexStatusSection", () => {
  beforeEach(() => {
    mocks.getConnection.mockResolvedValue({ siteUrl: "sc-domain:a.com" });
    mocks.listKeyPages.mockResolvedValue([
      { url: "https://a.com/d" },
      { url: "https://a.com/a" },
      { url: "https://a.com/b" },
      { url: "https://a.com/c" },
    ]);
    mocks.listForProject.mockResolvedValue([
      row("https://a.com/a", {
        verdict: "PASS",
        googleCanonical: "https://a.com/a",
        userCanonical: "https://a.com/a",
        inspectedAt: "2026-11-01T09:00:00.000Z",
      }),
      row("https://a.com/b", {
        verdict: "NEUTRAL",
        coverageState: "Crawled - currently not indexed",
        googleCanonical: "https://a.com/",
        userCanonical: "https://a.com/b",
      }),
      row("https://a.com/c", { error: "URL unknown" }),
      // A row for a page that is no longer a key page is ignored.
      row("https://a.com/old", { verdict: "PASS" }),
    ]);
  });

  it("maps each key page to a state, flags canonical mismatches and counts them", async () => {
    const section = await getIndexStatusSection("p");
    expect(section).toMatchObject({
      connected: true,
      capturedAt: "2026-11-02T10:00:00.000Z",
      nextCheckAfter: "2026-11-02T09:00:00.000Z",
      counts: { indexed: 1, notIndexed: 1, failed: 1, pending: 1 },
    });
    if (!section.connected) throw new Error("expected connected");
    expect(
      section.pages.map((p) => [p.url, p.state, p.canonicalMismatch]),
    ).toEqual([
      ["https://a.com/a", "indexed", false],
      ["https://a.com/b", "not_indexed", true],
      ["https://a.com/c", "failed", false],
      ["https://a.com/d", "pending", false],
    ]);
    expect(section.pages[1]).toMatchObject({
      coverageState: "Crawled - currently not indexed",
    });
  });

  it("is connected:false without a Search Console property", async () => {
    mocks.getConnection.mockResolvedValue(null);
    expect(await getIndexStatusSection("p")).toEqual({ connected: false });
  });

  it("has no stamps before the first run", async () => {
    mocks.listForProject.mockResolvedValue([]);
    expect(await getIndexStatusSection("p")).toMatchObject({
      capturedAt: null,
      nextCheckAfter: null,
      counts: { pending: 4 },
    });
  });
});
