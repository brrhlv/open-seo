import { createFileRoute } from "@tanstack/react-router";
import { ReportGscService } from "@/server/features/public-api/report/reportGscService";
import { serveReport } from "@/server/features/public-api/report/reportRoute";

// BRRHLV-375 report API R3: Search Console sitemaps.list.
export const Route = createFileRoute(
  "/api/public/v1/projects/$projectId/report/gsc/sitemaps",
)({
  server: {
    handlers: {
      GET: ({ request, params }: { request: Request; params: { projectId: string } }) =>
        serveReport(request, params.projectId, ReportGscService.listSitemaps),
    },
  },
});
