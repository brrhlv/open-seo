import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import { createGscClient } from "@/server/lib/gscClient";
import { GscApiError, GscTokenError } from "@/server/lib/gscErrors";
import { isUrlWithinDomain, requireProjectDomain } from "./reportDomain";
import { ReportApiError } from "./reportErrors";
import { readJsonBody, type ReportContext } from "./reportRequest";
import {
  gscInspectUrlBodySchema,
  gscSearchAnalyticsBodySchema,
} from "./reportSchemas";

/** The project's own connected property; never a caller-supplied siteUrl. */
async function connect(projectId: string) {
  const connection = await GscConnectionRepository.getByProjectId(projectId);
  if (!connection) throw new ReportApiError(409, "gsc_not_connected");
  return {
    siteUrl: connection.siteUrl,
    client: createGscClient({
      userId: connection.connectedByUserId,
      gscAccountId: connection.gscAccountId ?? undefined,
    }),
  };
}

/** Google call with typed failures kept (GscApiError / GscTokenError map via
 *  reportErrors). Anything else gscClient.request lets escape — a fetch
 *  rejection (TypeError) or an unparseable body — is a transport failure:
 *  502 upstream_error status 0 (spec deviation 4). */
async function callGoogle<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof GscApiError || error instanceof GscTokenError)
      throw error;
    throw new ReportApiError(502, "upstream_error", { status: 0 });
  }
}

/** R2: searchAnalytics.query, body as sent (the client returns rows; absent
 *  rows are already []). */
async function querySearchAnalytics({ project, request }: ReportContext) {
  const body = await readJsonBody(request, gscSearchAnalyticsBodySchema);
  const { siteUrl, client } = await connect(project.id);
  return {
    siteUrl,
    response: {
      rows: await callGoogle(() => client.querySearchAnalytics(siteUrl, body)),
    },
  };
}

/** R3: sitemaps.list, raw. */
async function listSitemaps({ project }: ReportContext) {
  const { siteUrl, client } = await connect(project.id);
  return {
    siteUrl,
    response: await callGoogle(() => client.listSitemaps(siteUrl)),
  };
}

/** R4: URL Inspection, only for URLs on the project's own domain. */
async function inspectUrl({ project, request }: ReportContext) {
  const body = await readJsonBody(request, gscInspectUrlBodySchema);
  const domain = requireProjectDomain(project.domain);
  if (!isUrlWithinDomain(body.inspectionUrl, domain)) {
    throw new ReportApiError(422, "invalid_request", {
      detail: "inspectionUrl must be an http(s) URL on the project domain",
    });
  }
  const { siteUrl, client } = await connect(project.id);
  return {
    siteUrl,
    response: {
      inspectionResult: await callGoogle(() =>
        client.inspectUrl(siteUrl, body.inspectionUrl),
      ),
    },
  };
}

export const ReportGscService = {
  querySearchAnalytics,
  listSitemaps,
  inspectUrl,
};
