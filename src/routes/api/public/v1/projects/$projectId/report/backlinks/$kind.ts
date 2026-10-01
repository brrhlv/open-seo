import { createFileRoute } from "@tanstack/react-router";
import { ReportBacklinksService } from "@/server/features/public-api/report/reportBacklinksService";
import { serveReport } from "@/server/features/public-api/report/reportRoute";

// BRRHLV-375 report API R5: DataForSEO backlinks summary|history|backlinks,
// target forced to the project domain; any other kind is a 404.
export const Route = createFileRoute(
  "/api/public/v1/projects/$projectId/report/backlinks/$kind",
)({
  server: {
    handlers: {
      POST: ({
        request,
        params,
      }: {
        request: Request;
        params: { projectId: string; kind: string };
      }) =>
        serveReport(request, params.projectId, (ctx) =>
          ReportBacklinksService.runBacklinksReport(ctx, params.kind),
        ),
    },
  },
});
