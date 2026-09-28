import { parsePublicApiKeys, resolveBoundProjects } from "./publicApiAuth";
import { parsePublicSummaryRange } from "./publicSummaryRange";
import { PublicSummaryService } from "./PublicSummaryService";

// The consumer caches on its side; never let an intermediary store a
// key-authenticated response.
const CACHE_HEADERS = { "Cache-Control": "private, max-age=0" };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: CACHE_HEADERS });
}

/** Trust boundary for the public summary route: a key (Authorization: Bearer
 *  or X-OpenSEO-Key) bound to exactly one project (OPENSEO_PUBLIC_API_KEYS).
 *  Deliberately independent of the Cloudflare Access user JWT — service-token
 *  JWTs carry no email. */
export async function handlePublicSummaryRequest(input: {
  request: Request;
  projectId: string;
  rawKeys: string | undefined;
}): Promise<Response> {
  const boundProjects = resolveBoundProjects(
    input.request.headers,
    parsePublicApiKeys(input.rawKeys),
  );
  if (boundProjects.size === 0) return json({ error: "unauthorized" }, 401);
  // A valid key for another project must not reveal whether this one exists.
  if (!boundProjects.has(input.projectId)) {
    return json({ error: "not_found" }, 404);
  }

  const range = parsePublicSummaryRange(
    new URL(input.request.url).searchParams.get("range"),
  );
  if (!range) return json({ error: "invalid_range" }, 422);

  try {
    const summary = await PublicSummaryService.getSummary({
      projectId: input.projectId,
      range,
    });
    return summary ? json(summary, 200) : json({ error: "not_found" }, 404);
  } catch (error) {
    console.error(
      "public-summary: request failed",
      { projectId: input.projectId },
      error,
    );
    return json({ error: "internal_error" }, 500);
  }
}
