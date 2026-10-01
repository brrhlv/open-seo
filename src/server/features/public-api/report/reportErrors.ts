import { AppError } from "@/server/lib/errors";
import { Ga4DataApiError, Ga4TokenError } from "@/server/lib/ga4Errors";
import {
  GscApiError,
  GscNotConnectedError,
  GscTokenError,
} from "@/server/lib/gscErrors";

// Report API error envelope (BRRHLV-375 spec): HTTP status + {error: code}.
// A leaf module (like gscErrors/ga4Errors) so services and tests import it
// without the route's runtime graph. 401 `unauthorized` is answered directly
// by reportHandler before any service runs.
type ReportErrorCode =
  | "not_found"
  | "ga4_not_connected"
  | "gsc_not_connected"
  | "no_rank_tracker"
  | "no_audit"
  | "no_domain"
  | "invalid_request"
  | "upstream_quota"
  | "upstream_error"
  | "internal_error";

/** Extra wire fields: `detail` (422) and the upstream `status` (502). */
type ReportErrorExtra = { detail?: string; status?: number };

export class ReportApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: ReportErrorCode,
    public readonly extra: ReportErrorExtra = {},
  ) {
    super(code);
    this.name = "ReportApiError";
  }

  toBody(): { error: ReportErrorCode } & ReportErrorExtra {
    return { error: this.code, ...this.extra };
  }
}

function fromUpstreamStatus(status: number): ReportApiError {
  return status === 429
    ? new ReportApiError(429, "upstream_quota")
    : new ReportApiError(502, "upstream_error", { status });
}

/** Any failure from a report service → the wire error. Unknown errors are 500s. */
export function toReportApiError(error: unknown): ReportApiError {
  if (error instanceof ReportApiError) return error;
  if (error instanceof GscNotConnectedError) {
    return new ReportApiError(409, "gsc_not_connected");
  }
  // A dead or revoked Google grant: reconnect the project in OpenSEO.
  if (error instanceof GscTokenError || error instanceof Ga4TokenError) {
    return new ReportApiError(502, "upstream_error", { status: 401 });
  }
  if (error instanceof GscApiError || error instanceof Ga4DataApiError) {
    return fromUpstreamStatus(error.status);
  }
  return new ReportApiError(500, "internal_error");
}

/** DataForSEO transport failures (AppError thrown by dataforseo/core) → wire. */
export function toDataforseoReportApiError(error: unknown): ReportApiError {
  if (!(error instanceof AppError)) return toReportApiError(error);
  if (error.code === "RATE_LIMITED") {
    return new ReportApiError(429, "upstream_quota");
  }
  const status = Number(error.details?.providerStatus ?? 0);
  return new ReportApiError(502, "upstream_error", {
    status: Number.isInteger(status) ? status : 0,
  });
}
