import { describe, expect, it } from "vitest";
import { AppError } from "@/server/lib/errors";
import {
  Ga4DataApiError,
  Ga4MalformedResponseError,
  Ga4TokenError,
} from "@/server/lib/ga4Errors";
import {
  GscApiError,
  GscNotConnectedError,
  GscTokenError,
} from "@/server/lib/gscErrors";
import {
  ReportApiError,
  toDataforseoReportApiError,
  toReportApiError,
} from "./reportErrors";

function wire(error: ReportApiError) {
  return [error.httpStatus, error.toBody()];
}

describe("toReportApiError", () => {
  it.each<[string, unknown, number, Record<string, unknown>]>([
    [
      "unlinked GSC",
      new GscNotConnectedError("p"),
      409,
      { error: "gsc_not_connected" },
    ],
    [
      "dead GSC grant",
      new GscTokenError("revoked"),
      502,
      { error: "upstream_error", status: 401 },
    ],
    [
      "dead GA4 grant",
      new Ga4TokenError("revoked"),
      502,
      { error: "upstream_error", status: 401 },
    ],
    ["GSC 429", new GscApiError(429, "slow"), 429, { error: "upstream_quota" }],
    [
      "GA4 429",
      new Ga4DataApiError(429, "quota"),
      429,
      { error: "upstream_quota" },
    ],
    [
      "GSC 403",
      new GscApiError(403, "denied"),
      502,
      { error: "upstream_error", status: 403 },
    ],
    [
      "GA4 transport",
      new Ga4DataApiError(0, "down"),
      502,
      { error: "upstream_error", status: 0 },
    ],
    ["anything else", new Error("boom"), 500, { error: "internal_error" }],
    [
      "GA4 malformed response",
      new Ga4MalformedResponseError(),
      502,
      { error: "upstream_error", status: 0 },
    ],
  ])("maps %s", (_label, error, status, body) => {
    expect(wire(toReportApiError(error))).toEqual([status, body]);
  });

  it("passes a ReportApiError through with its detail", () => {
    const error = new ReportApiError(422, "invalid_request", { detail: "x" });
    expect(toReportApiError(error)).toBe(error);
    expect(error.toBody()).toEqual({ error: "invalid_request", detail: "x" });
  });
});

describe("toDataforseoReportApiError", () => {
  it.each<[string, AppError, number, Record<string, unknown>]>([
    [
      "429",
      new AppError("RATE_LIMITED", "x", { providerStatus: "429" }),
      429,
      { error: "upstream_quota" },
    ],
    [
      "5xx",
      new AppError("UPSTREAM_UNAVAILABLE", "x", { providerStatus: "503" }),
      502,
      { error: "upstream_error", status: 503 },
    ],
    [
      "billing (no HTTP status)",
      new AppError("BACKLINKS_BILLING_ISSUE", "x"),
      502,
      { error: "upstream_error", status: 0 },
    ],
    [
      "non-numeric providerStatus",
      new AppError("UPSTREAM_UNAVAILABLE", "x", { providerStatus: "abc" }),
      502,
      { error: "upstream_error", status: 0 },
    ],
  ])("maps a DataForSEO %s", (_label, error, status, body) => {
    expect(wire(toDataforseoReportApiError(error))).toEqual([status, body]);
  });

  it("falls through to toReportApiError for a non-AppError", () => {
    expect(wire(toDataforseoReportApiError(new Error("boom")))).toEqual([
      500,
      { error: "internal_error" },
    ]);
  });
});
