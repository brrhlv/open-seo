import { beforeEach, describe, expect, it, vi } from "vitest";
import { handlePublicSummaryRequest } from "./publicSummaryHandler";

const mocks = vi.hoisted(() => ({ getSummary: vi.fn() }));

vi.mock("./PublicSummaryService", () => ({
  PublicSummaryService: { getSummary: mocks.getSummary },
}));

const KEY = "k".repeat(64);
const RAW_KEYS = `${KEY}:proj-a`;

function call(
  options: {
    projectId?: string;
    query?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const projectId = options.projectId ?? "proj-a";
  return handlePublicSummaryRequest({
    request: new Request(
      `https://seo.test/api/public/v1/projects/${projectId}/summary${options.query ?? ""}`,
      { headers: options.headers ?? { authorization: `Bearer ${KEY}` } },
    ),
    projectId,
    rawKeys: RAW_KEYS,
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
});
