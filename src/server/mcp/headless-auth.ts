import { createRemoteJWKSet, jwtVerify } from "jose";
import { API_KEY_PREFIX } from "@/lib/auth-api-key";
import { resolveSharedWorkspaceContext } from "@/middleware/ensure-user/delegated";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { timingSafeEqual } from "@/server/lib/timingSafeEqual";
import { MCP_ROUTE } from "@/server/mcp/context";
import { handleSelfHostedMcpForIdentity } from "@/server/mcp/transport";
import { validateTeamDomain } from "@/shared/selfhost-checks";

/**
 * Headless MCP for self-host (PAI-254): agents and crons that cannot finish
 * the interactive Access Managed OAuth flow on /mcp.
 *
 * Two gates, both required:
 * 1. A path-scoped Cloudflare Access app on MCP_HEADLESS_ROUTE whose only
 *    policy is a service token. The worker re-verifies that app's JWT
 *    (MCP_HEADLESS_POLICY_AUD) and its common_name allowlist, so a browser
 *    JWT from the email app (other AUD, no common_name) never passes.
 * 2. An `oseo_` key whose SHA-256 is bound to one existing user in
 *    OPENSEO_MCP_API_KEYS. The worker only stores hashes.
 *
 * /mcp itself (interactive OAuth through the email app) is unchanged.
 */
export const MCP_HEADLESS_ROUTE = "/mcp/headless";

export type HeadlessMcpEnv = {
  TEAM_DOMAIN?: string;
  MCP_HEADLESS_POLICY_AUD?: string;
  MCP_HEADLESS_SERVICE_TOKEN_CLIENT_IDS?: string;
  OPENSEO_MCP_API_KEYS?: string;
};

type McpApiKey = { hash: string; userId: string };

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const MAX_PRESENTED_KEY_LENGTH = 256;

/** OPENSEO_MCP_API_KEYS = "sha256hex:userId[,sha256hex:userId]". Malformed
 *  entries are dropped (fail closed); only their count is logged. */
export function parseMcpApiKeys(raw: string | undefined): McpApiKey[] {
  const keys: McpApiKey[] = [];
  let dropped = 0;
  for (const entry of (raw ?? "").split(",")) {
    if (!entry.trim()) continue;
    const separator = entry.indexOf(":");
    const hash = entry.slice(0, separator).trim().toLowerCase();
    const userId = entry.slice(separator + 1).trim();
    if (separator < 0 || !SHA256_HEX_RE.test(hash) || !userId) {
      dropped++;
      continue;
    }
    keys.push({ hash, userId });
  }
  if (dropped > 0) {
    console.warn(`[mcp-headless] dropped ${dropped} malformed key entries`);
  }
  return keys;
}

function json(status: number, error: string) {
  console.debug(`[mcp-headless] ${status} ${error}`);
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function presentedKey(headers: Headers) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(
    headers.get("authorization")?.trim() ?? "",
  )?.[1];
  const key = bearer ?? headers.get("x-api-key")?.trim();
  if (
    !key ||
    !key.startsWith(API_KEY_PREFIX) ||
    key.length > MAX_PRESENTED_KEY_LENGTH
  ) {
    return null;
  }
  return key;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const jwksByTeamDomain = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

async function isAllowedServiceToken(
  headers: Headers,
  teamDomain: string,
  audience: string,
  allowedClientIds: string[],
) {
  const token = headers.get("cf-access-jwt-assertion");
  if (!token) return false;
  let jwks = jwksByTeamDomain.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeamDomain.set(teamDomain, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: teamDomain,
      audience,
    });
    const commonName = payload["common_name"];
    return (
      typeof commonName === "string" && allowedClientIds.includes(commonName)
    );
  } catch {
    return false;
  }
}

export async function handleHeadlessMcpRequest(
  request: Request,
  env: HeadlessMcpEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const team = env.TEAM_DOMAIN ? validateTeamDomain(env.TEAM_DOMAIN) : null;
  const audience = env.MCP_HEADLESS_POLICY_AUD?.trim();
  const keys = parseMcpApiKeys(env.OPENSEO_MCP_API_KEYS);
  const allowedClientIds = (env.MCP_HEADLESS_SERVICE_TOKEN_CLIENT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!team?.ok || !audience || keys.length === 0) {
    return new Response("Not Found", { status: 404 });
  }

  try {
    if (
      !(await isAllowedServiceToken(
        request.headers,
        team.origin,
        audience,
        allowedClientIds,
      ))
    ) {
      return json(403, "access_denied");
    }

    const key = presentedKey(request.headers);
    if (!key) return json(401, "invalid_api_key");
    const hash = await sha256Hex(key);
    let userId: string | null = null;
    // Compare against every entry, no early exit.
    for (const entry of keys) {
      if (timingSafeEqual(hash, entry.hash)) userId = entry.userId;
    }
    if (!userId) return json(401, "invalid_api_key");

    // Never create a user here (unlike first-login ensureUserRecord): the
    // key must point at someone who already signed in through Access.
    const user = await AuthRepository.getHostedUser(userId);
    if (!user?.email) return json(401, "invalid_api_key");
    const identity = await resolveSharedWorkspaceContext(user.id, user.email);

    const url = new URL(request.url);
    url.pathname = MCP_ROUTE;
    return await handleSelfHostedMcpForIdentity(
      new Request(url, request),
      identity,
      env,
      ctx,
    );
  } catch (error) {
    console.error("[mcp-headless] 500 (internal):", error);
    return json(500, "internal_error");
  }
}
