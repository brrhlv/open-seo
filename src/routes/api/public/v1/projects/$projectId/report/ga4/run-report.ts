import { createFileRoute } from "@tanstack/react-router";
import { ReportGa4Service } from "@/server/features/public-api/report/reportGa4Service";
import { serveReport } from "@/server/features/public-api/report/reportRoute";

// BRRHLV-375 report API R1: raw GA4 runReport on the key's project property.
export const Route = createFileRoute(
  "/api/public/v1/projects/$projectId/report/ga4/run-report",
)({
  server: {
    handlers: {
      POST: ({ request, params }: { request: Request; params: { projectId: string } }) =>
        serveReport(request, params.projectId, ReportGa4Service.runGa4Report),
    },
  },
});
