import { ProjectService } from "@/server/features/projects/services/ProjectService";
import {
  parsePublicApiKeys,
  resolveBoundProjects,
} from "@/server/features/public-api/publicApiAuth";
import { toReportApiError } from "./reportErrors";
import type { ReportContext } from "./reportRequest";

// Key-authenticated responses must never be stored by an intermediary.
const NO_STORE = { "Cache-Control": "private, max-age=0" };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** Trust boundary shared by every report route (BRRHLV-375), same as the
 *  PAI-222 summary route: hosted → 404; no/unknown key → 401; a key bound to
 *  another project → 404 (never reveals whether this one exists) — all before
 *  any DB read. The action only ever sees the path project its key is bound
 *  to; no service reads a project id from the body. */
export async function handleReportRequest(
  input: {
    request: Request;
    projectId: string;
    rawKeys: string | undefined;
    isHosted: boolean;
  },
  action: (ctx: ReportContext) => Promise<unknown>,
): Promise<Response> {
  if (input.isHosted) return json({ error: "not_found" }, 404);

  const bound = resolveBoundProjects(
    input.request.headers,
    parsePublicApiKeys(input.rawKeys),
  );
  if (bound.size === 0) return json({ error: "unauthorized" }, 401);
  if (!bound.has(input.projectId)) return json({ error: "not_found" }, 404);

  try {
    const found = await ProjectService.getProjectWithOrganization(
      input.projectId,
    );
    if (!found) return json({ error: "not_found" }, 404);
    const body = await action({
      project: { id: found.project.id, domain: found.project.domain },
      request: input.request,
    });
    return json(body, 200);
  } catch (error) {
    const mapped = toReportApiError(error);
    if (mapped.httpStatus >= 500) {
      // Never log headers or keys: project id, wire code and the error only.
      console.error(
        "report-api: request failed",
        { projectId: input.projectId, code: mapped.code },
        error,
      );
    }
    return json(mapped.toBody(), mapped.httpStatus);
  }
}
