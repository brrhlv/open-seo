import { Ga4ReportError } from "@/server/lib/ga4Errors";
import { GscApiError } from "@/server/lib/gscErrors";

/** The `{ error }` code a failed summary section reports. */
export function sectionErrorCode(error: unknown): string {
  if (error instanceof Ga4ReportError) return error.code;
  if (error instanceof GscApiError) {
    return error.status === 429
      ? "gsc_quota_exhausted"
      : "gsc_upstream_unavailable";
  }
  return "internal_error";
}
