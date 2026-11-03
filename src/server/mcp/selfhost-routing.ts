import { MCP_ROUTE } from "@/server/mcp/context";
import {
  handleHeadlessMcpRequest,
  type HeadlessMcpEnv,
  MCP_HEADLESS_ROUTE,
} from "@/server/mcp/headless-auth";
import { handleSelfHostedOpenSeoMcpRequest } from "@/server/mcp/transport";

/** Self-host (non-hosted) MCP routing, split out of src/server.ts so it can be
 *  tested without importing the whole worker. Returns null when the path is
 *  not an MCP route, leaving it to the app.
 *
 *  - /mcp/headless (PAI-254): service token + oseo_ key, cloudflare_access only.
 *  - /mcp: the Access JWT (cloudflare_access) or the local admin (local_noauth). */
export function routeSelfHostedMcpRequest(
  request: Request,
  authMode: "cloudflare_access" | "local_noauth",
  env: HeadlessMcpEnv,
  ctx: ExecutionContext,
): Promise<Response> | null {
  const pathname = new URL(request.url).pathname;

  if (authMode === "cloudflare_access" && pathname === MCP_HEADLESS_ROUTE) {
    return handleHeadlessMcpRequest(request, env, ctx);
  }

  if (pathname === MCP_ROUTE) {
    return handleSelfHostedOpenSeoMcpRequest(request, authMode, env, ctx);
  }

  return null;
}
