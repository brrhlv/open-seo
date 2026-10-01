import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { createGa4DataClient } from "@/server/lib/ga4Client";
import { ReportApiError } from "./reportErrors";
import { readJsonBody, type ReportContext } from "./reportRequest";
import { ga4RunReportBodySchema } from "./reportSchemas";

/** R1: a brrhlv-built runReport body against the project's connected GA4
 *  property; the upstream JSON is returned untouched. */
async function runGa4Report({ project, request }: ReportContext) {
  const body = await readJsonBody(request, ga4RunReportBodySchema);
  const connection = await Ga4ConnectionRepository.getByProjectId(project.id);
  if (!connection) throw new ReportApiError(409, "ga4_not_connected");
  const client = createGa4DataClient({
    userId: connection.connectedByUserId,
    ga4AccountId: connection.ga4AccountId,
    propertyId: connection.propertyId,
  });
  return {
    propertyId: connection.propertyId,
    timeZone: connection.propertyTimeZone,
    response: await client.runReportRaw(body),
  };
}

export const ReportGa4Service = { runGa4Report };
