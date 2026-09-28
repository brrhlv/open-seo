import { parsePublicApiKeys, resolveBoundProjects } from "./publicApiAuth";
import {
  parsePublicSummaryRange,
  resolvePublicSummaryDates,
} from "./publicSummaryRange";
import { PublicSummaryService } from "./PublicSummaryService";

// The consumer caches on its side; never let an intermediary store a
// key-authenticated response.
const CACHE_HEADERS = { "Cache-Control": "private, max-age=0" };
// Workers Cache API TTL (seconds). Keys rotate daily (rangeEnd in cache key).
const CACHE_TTL_SECONDS = 15 * 60; // 15 min

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: CACHE_HEADERS });
}

/** Narrow a section value: is it a `{error: string}` sentinel? */
function isSectionError(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  );
}

/** Abstracted so tests can inject a fake instead of relying on caches.default. */
export interface SummaryCache {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
}

/** Returns caches.default when available (Cloudflare Workers runtime), null
 *  otherwise (test / local Node). */
function defaultCacheStore(): SummaryCache | null {
  try {
    // caches is a global in Workers; undefined in Node/test environments.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- caches is a CF Workers global absent in Node
    const c = (globalThis as unknown as { caches?: { default?: SummaryCache } })
      .caches?.default;
    return c ?? null;
  } catch {
    return null;
  }
}

/** Trust boundary for the public summary route: a key (Authorization: Bearer
 *  or X-OpenSEO-Key) bound to exactly one project (OPENSEO_PUBLIC_API_KEYS).
 *  Deliberately independent of the Cloudflare Access user JWT — service-token
 *  JWTs carry no email. */
export async function handlePublicSummaryRequest(input: {
  request: Request;
  projectId: string;
  rawKeys: string | undefined;
  /** Hosted-mode flag from the route; returns 404 JSON without auth. */
  isHosted?: boolean;
  /** Inject a SummaryCache (tests pass null; absent = use caches.default). */
  cache?: SummaryCache | null;
}): Promise<Response> {
  if (input.isHosted) return json({ error: "not_found" }, 404);

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

  // Cache key: non-secret, includes rangeEnd so it rotates daily with the lag.
  const { end: rangeEnd } = resolvePublicSummaryDates(range);
  const cacheKey = `https://public-summary.internal/${input.projectId}/${range}/${rangeEnd}`;
  const cache = "cache" in input ? input.cache : defaultCacheStore();

  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return json(await cached.json(), 200);
    } catch {
      // Non-fatal — fall through to origin.
    }
  }

  try {
    const summary = await PublicSummaryService.getSummary({
      projectId: input.projectId,
      range,
    });
    if (!summary) return json({ error: "not_found" }, 404);

    // Only cache when every section resolved cleanly (transient errors retry).
    const sections = [
      summary.rankings,
      summary.backlinks,
      summary.audit,
      summary.gsc,
      summary.ga4,
    ] as unknown[];
    if (cache && !sections.some(isSectionError)) {
      cache
        .put(
          cacheKey,
          Response.json(summary, {
            headers: { "Cache-Control": `max-age=${CACHE_TTL_SECONDS}` },
          }),
        )
        .catch(() => {
          /* non-fatal */
        });
    }

    return json(summary, 200);
  } catch (error) {
    console.error(
      "public-summary: request failed",
      { projectId: input.projectId },
      error,
    );
    return json({ error: "internal_error" }, 500);
  }
}
