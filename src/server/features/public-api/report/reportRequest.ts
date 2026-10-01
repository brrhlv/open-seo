import type { z } from "zod";
import { ReportApiError } from "./reportErrors";

/** What a report service receives: the project the key is bound to (id from
 *  the path, domain from the DB — never from the body) and the raw request. */
export type ReportContext = {
  project: { id: string; domain: string | null };
  request: Request;
};

const MAX_DETAIL_LENGTH = 500;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form ("2026-02-30" is rejected). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function invalid(detail: string): ReportApiError {
  return new ReportApiError(422, "invalid_request", {
    detail: detail.slice(0, MAX_DETAIL_LENGTH),
  });
}

/** JSON body validated by `schema`; any failure is a 422 with a short detail. */
export async function readJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw invalid("body must be a JSON object");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(
      parsed.error.issues
        .map(
          (issue) =>
            `${issue.path.map(String).join(".") || "body"}: ${issue.message}`,
        )
        .join("; "),
    );
  }
  return parsed.data;
}

/** Optional YYYY-MM-DD query param: null when absent, 422 when malformed. */
export function readDateParam(request: Request, name: string): string | null {
  const value = new URL(request.url).searchParams.get(name);
  if (value === null) return null;
  if (!isIsoDate(value)) throw invalid(`${name} must be a YYYY-MM-DD date`);
  return value;
}

export function requireDateParam(request: Request, name: string): string {
  const value = readDateParam(request, name);
  if (value === null) throw invalid(`${name} is required (YYYY-MM-DD)`);
  return value;
}
