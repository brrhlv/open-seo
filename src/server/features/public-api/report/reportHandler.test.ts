import { beforeEach, describe, expect, it, vi } from "vitest";
import { GscApiError } from "@/server/lib/gscErrors";
import { ReportApiError } from "./reportErrors";
import { handleReportRequest } from "./reportHandler";
import type { ReportContext } from "./reportRequest";

const mocks = vi.hoisted(() => ({ getProjectWithOrganization: vi.fn() }));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectWithOrganization: mocks.getProjectWithOrganization,
  },
}));

const KEY = "r".repeat(64);

function call(
  action: (ctx: ReportContext) => Promise<unknown>,
  {
    projectId = "proj-a",
    headers = { authorization: `Bearer ${KEY}` } as Record<string, string>,
    isHosted = false,
  } = {},
) {
  return handleReportRequest(
    {
      request: new Request(
        `https://seo.test/api/public/v1/projects/${projectId}/report/audit`,
        { headers },
      ),
      projectId,
      rawKeys: `${KEY}:proj-a`,
      isHosted,
    },
    action,
  );
}

describe("handleReportRequest", () => {
  beforeEach(() => {
    mocks.getProjectWithOrganization.mockResolvedValue({
      organizationId: "org-1",
      project: { id: "proj-a", domain: "socialboothlv.com", name: "x" },
    });
  });

  it.each<[string, Parameters<typeof call>[1], number, string]>([
    ["hosted mode", { isHosted: true }, 404, "not_found"],
    [
      "an unknown key",
      { headers: { authorization: `Bearer ${"x".repeat(64)}` } },
      401,
      "unauthorized",
    ],
    ["no key", { headers: {} }, 401, "unauthorized"],
    [
      "a key bound to another project",
      { projectId: "proj-b" },
      404,
      "not_found",
    ],
  ])("rejects %s before any DB read", async (_label, options, status, code) => {
    const action = vi.fn();
    const response = await call(action, options);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
    expect(response.headers.get("cache-control")).toBe("private, max-age=0");
    expect(mocks.getProjectWithOrganization).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it("returns 404 when the bound project no longer exists", async () => {
    mocks.getProjectWithOrganization.mockResolvedValue(null);
    expect((await call(vi.fn())).status).toBe(404);
  });

  it("runs the action with the path-bound project and returns 200, never cached", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    const response = await call(action, { headers: { "x-openseo-key": KEY } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=0");
    expect(await response.json()).toEqual({ ok: true });
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({
        project: { id: "proj-a", domain: "socialboothlv.com" },
      }),
    );
  });

  it.each<[string, unknown, number, Record<string, unknown>]>([
    [
      "a validation error",
      new ReportApiError(422, "invalid_request", { detail: "bad" }),
      422,
      { error: "invalid_request", detail: "bad" },
    ],
    [
      "a missing connection",
      new ReportApiError(409, "no_audit"),
      409,
      { error: "no_audit" },
    ],
    [
      "a Google quota error",
      new GscApiError(429, "slow"),
      429,
      { error: "upstream_quota" },
    ],
    [
      "an unexpected error",
      new Error("db down"),
      500,
      { error: "internal_error" },
    ],
  ])("maps %s to the error envelope", async (_label, thrown, status, body) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call(() => Promise.reject(thrown));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  });

  it("logs 5xx errors but not 4xx errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await call(() => Promise.reject(new Error("db down")));
    expect(spy).toHaveBeenCalledOnce();

    spy.mockClear();
    await call(() => Promise.reject(new ReportApiError(409, "no_audit")));
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it("never logs the Authorization or X-OpenSEO-Key value", async () => {
    const logged: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      logged.push(...args);
    });

    await call(() => Promise.reject(new Error("db down")));

    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain(KEY);

    vi.restoreAllMocks();
  });
});
