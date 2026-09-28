import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { isHostedAuthMode } from "@/lib/auth-mode";
import { handlePublicSummaryRequest } from "@/server/features/public-api/publicSummaryHandler";

// Read-only, key-authenticated project summary for external dashboards
// (PAI-222). A raw route: it establishes its own trust boundary (a key in
// Authorization: Bearer or X-OpenSEO-Key, bound to one project via
// OPENSEO_PUBLIC_API_KEYS) and never reads the
// Cloudflare Access user JWT. In the self-host deploy a path-scoped Access
// application with a service-token policy also fronts /api/public/*.
// Self-host only — hosted mode answers 404.
export const Route = createFileRoute(
  "/api/public/v1/projects/$projectId/summary",
)({
  server: {
    handlers: {
      GET: ({
        request,
        params,
      }: {
        request: Request;
        params: { projectId: string };
      }) => {
        if (isHostedAuthMode(env.AUTH_MODE)) {
          return new Response("Not found", { status: 404 });
        }
        return handlePublicSummaryRequest({
          request,
          projectId: params.projectId,
          rawKeys: env.OPENSEO_PUBLIC_API_KEYS,
        });
      },
    },
  },
});
