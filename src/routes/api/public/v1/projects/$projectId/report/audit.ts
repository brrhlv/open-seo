import { createFileRoute } from "@tanstack/react-router";
import { ReportAuditService } from "@/server/features/public-api/report/reportAuditService";
import { serveReport } from "@/server/features/public-api/report/reportRoute";

// BRRHLV-375 report API R7: ?asOf=YYYY-MM-DD.
export const Route = createFileRoute(
  "/api/public/v1/projects/$projectId/report/audit",
)({
  server: {
    handlers: {
      GET: ({ request, params }: { request: Request; params: { projectId: string } }) =>
        serveReport(request, params.projectId, ReportAuditService.getAudit),
    },
  },
});
