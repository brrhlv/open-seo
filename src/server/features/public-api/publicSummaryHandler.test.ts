import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handlePublicSummaryRequest,
  type SummaryCache,
} from "./publicSummaryHandler";

const mocks = vi.hoisted(() => ({ getSummary: vi.fn() }));

vi.mock("./PublicSummaryService", () => ({
  PublicSummaryService: { getSummary: mocks.getSummary },
}));

const KEY = "k".repeat(64);
const RAW_KEYS = `${KEY}:proj-a`;

function call({
  projectId = "proj-a",
  query = "",
  headers = { authorization: `Bearer ${KEY}` },
  cache = null as SummaryCache | null,
  isHosted = false,
}: {
  projectId?: string;
  query?: string;
  headers?: Record<string, string>;
  cache?: SummaryCache | null;
  isHosted?: boolean;
} = {}) {
  return handlePublicSummaryRequest({
    request: new Request(
      `https://seo.test/api/public/v1/projects/${projectId}/summary${query}`,
      { headers },
    ),
    projectId,
    rawKeys: RAW_KEYS,
    cache,
    isHosted,
  });
}

describe("handlePublicSummaryRequest", () => {
  beforeEach(() => {
    mocks.getSummary.mockResolvedValue({ project: { id: "proj-a" } });
  });

  it("returns 401 for an unknown key without touching data", async () => {
    const response = await call({
      headers: { authorization: `Bearer ${"x".repeat(64)}` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.getSummary).not.toHaveBeenCalled();
  });

  it("returns 200 with only a valid X-OpenSEO-Key header", async () => {
    expect((await call({ headers: { "x-openseo-key": KEY } })).status).toBe(
      200,
    );
  });

  it("returns 401 with only a wrong X-OpenSEO-Key header", async () => {
    const response = await call({ headers: { "x-openseo-key": "wrong" } });
    expect(response.status).toBe(401);
    expect(mocks.getSummary).not.toHaveBeenCalled();
  });

  it("returns 200 when the Bearer key is wrong but X-OpenSEO-Key is valid", async () => {
    const response = await call({
      headers: { authorization: "Bearer wrong", "x-openseo-key": KEY },
    });
    expect(response.status).toBe(200);
  });

  it("returns 404 when the key is bound to a different project", async () => {
    const response = await call({ projectId: "proj-b" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mocks.getSummary).not.toHaveBeenCalled();
  });

  it("returns 422 for an unsupported range", async () => {
    const response = await call({ query: "?range=last_3_months" });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid_range" });
  });

  it("returns the summary for the default range with a private no-cache header", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=0");
    expect(await response.json()).toEqual({ project: { id: "proj-a" } });
    expect(mocks.getSummary).toHaveBeenCalledWith({
      projectId: "proj-a",
      range: "last_28_days",
    });
  });

  it("returns 404 when the bound project no longer exists", async () => {
    mocks.getSummary.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it("returns a generic 500 when the summary throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getSummary.mockRejectedValue(new Error("db down"));
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });

  // ── Hosted mode ──────────────────────────────────────────────────────────

  it("returns 404 JSON with Cache-Control for hosted mode, no auth check", async () => {
    const response = await handlePublicSummaryRequest({
      request: new Request(
        "https://seo.test/api/public/v1/projects/proj-a/summary",
      ),
      projectId: "proj-a",
      rawKeys: RAW_KEYS,
      isHosted: true,
      cache: null,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(response.headers.get("cache-control")).toBe("private, max-age=0");
    expect(mocks.getSummary).not.toHaveBeenCalled();
  });

  // ── Cache ─────────────────────────────────────────────────────────────────

  it("returns a cache hit without calling getSummary", async () => {
    const cachedBody = { project: { id: "proj-a", fromCache: true } };
    const fakeCache: SummaryCache = {
      match: vi.fn().mockResolvedValue(Response.json(cachedBody)),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const response = await call({ cache: fakeCache });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=0");
    expect(await response.json()).toMatchObject({ project: { id: "proj-a" } });
    expect(mocks.getSummary).not.toHaveBeenCalled();
  });

  it("stores the summary in cache on a miss when all sections are clean", async () => {
    const put = vi
      .fn<(url: string, response: Response) => Promise<void>>()
      .mockResolvedValue(undefined);
    const fakeCache: SummaryCache = {
      match: vi.fn().mockResolvedValue(undefined),
      put,
    };
    await call({ cache: fakeCache });
    expect(put).toHaveBeenCalledTimes(1);
    // Cache key must not contain the auth key; must include projectId and range.
    const [cacheKey] = put.mock.calls[0];
    expect(cacheKey).toContain("proj-a");
    expect(cacheKey).toContain("last_28_days");
    expect(cacheKey).not.toContain(KEY);
  });

  it("skips caching when a section has an error", async () => {
    mocks.getSummary.mockResolvedValue({
      project: { id: "proj-a" },
      rankings: { error: "internal_error" },
      backlinks: {},
      audit: {},
      gsc: {},
      ga4: {},
    });
    const put = vi
      .fn<(url: string, response: Response) => Promise<void>>()
      .mockResolvedValue(undefined);
    const fakeCache: SummaryCache = {
      match: vi.fn().mockResolvedValue(undefined),
      put,
    };
    await call({ cache: fakeCache });
    expect(put).not.toHaveBeenCalled();
  });

  it("falls through on cache errors without failing the request", async () => {
    const fakeCache: SummaryCache = {
      match: vi.fn().mockRejectedValue(new Error("cache unavailable")),
      put: vi.fn().mockRejectedValue(new Error("cache unavailable")),
    };
    const response = await call({ cache: fakeCache });
    expect(response.status).toBe(200);
  });
});
