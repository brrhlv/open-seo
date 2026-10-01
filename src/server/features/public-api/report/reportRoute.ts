import { env } from "cloudflare:workers";
import { isHostedAuthMode } from "@/lib/auth-mode";
import { handleReportRequest } from "./reportHandler";
import type { ReportContext } from "./reportRequest";

/** Route glue: binds the Worker env (key map + auth mode) to the shared
 *  report handler. Raw routes: no ensureUser, no Access user JWT. */
export function serveReport(
  request: Request,
  projectId: string,
  action: (ctx: ReportContext) => Promise<unknown>,
): Promise<Response> {
  return handleReportRequest(
    {
      request,
      projectId,
      rawKeys: env.OPENSEO_PUBLIC_API_KEYS,
      isHosted: isHostedAuthMode(env.AUTH_MODE),
    },
    action,
  );
}
