import { createFileRoute } from "@tanstack/react-router";
import { ReportRankingsService } from "@/server/features/public-api/report/reportRankingsService";
import { serveReport } from "@/server/features/public-api/report/reportRoute";

// BRRHLV-375 report API R6: ?asOf=YYYY-MM-DD[&compareTo=YYYY-MM-DD].
export const Route = createFileRoute(
  "/api/public/v1/projects/$projectId/report/rankings",
)({
  server: {
    handlers: {
      GET: ({ request, params }: { request: Request; params: { projectId: string } }) =>
        serveReport(request, params.projectId, ReportRankingsService.getRankings),
    },
  },
});
