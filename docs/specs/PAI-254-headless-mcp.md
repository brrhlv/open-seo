# PAI-254: Headless OpenSEO MCP (no OAuth)

Status: spec + code on branch `PAI-254/headless-mcp`. Not deployed.
Owner: Claude (PAI-254). Related: PAI-182 (self-host), PAI-222 (public API path app).

## Goal

Agents, subagents and crons call the OpenSEO MCP tools (`run_site_audit`,
`get_local_rank_grid`, `get_audit_status`, ...) without the interactive
Access Managed OAuth flow, which lapses and cannot be completed headless.
`/mcp` itself must never become public.

## What the code actually does today (findings)

1. **Self-host never reads `oseo_` keys.** `src/server.ts` sends `/mcp` to
   `handleSelfHostedOpenSeoMcpRequest` when `AUTH_MODE=cloudflare_access`.
   The `oseo_` path (`src/server/mcp/api-key-auth.ts`) only runs inside
   `createOpenSeoOAuthProvider`, which is hosted mode only. The better-auth
   apiKey plugin is registered only in hosted mode
   (`src/lib/auth.ts`: `isHostedAuthMode(env.AUTH_MODE) ? [createApiKeyPlugin()] : []`).
   The D1 `apikey` table exists but is empty, and there is no UI or route
   that mints a key in self-host mode.
2. **Even in hosted mode the plugin path would fail here:** it calls
   `resolveExistingActiveHostedOrganization`, which needs `member` rows.
   Self-host uses the delegated `shared-workspace` org with no member rows,
   so it would answer 403 `account_access_revoked`.
3. **Self-host `/mcp` identity = the Access JWT.** `resolveCloudflareAccessContext`
   verifies `Cf-Access-Jwt-Assertion` against `TEAM_DOMAIN` and the single
   `POLICY_AUD` (email app `0f0045d6-…`), then requires `sub` and `email`.
   An Access service-token JWT has `common_name` (the client id), an empty
   `sub` and no `email`, so it is rejected (UNAUTHENTICATED) even if Access
   lets it through.

So headless MCP is impossible without a code change. Inserting a row into
the `apikey` table would do nothing.

## Design

A second MCP entry point, `POST https://seo.bryanrivera.ai/mcp/headless`,
with two independent gates. Both must pass.

| Gate | Where | Checks |
|---|---|---|
| 1. Cloudflare Access | edge | New path app `seo.bryanrivera.ai/mcp/headless`, one `non_identity` policy whose only include is service token `pai-openseo-mcp`. No email policy, no bypass. |
| 2. App | worker | (a) the Access JWT verifies against `TEAM_DOMAIN` + `MCP_HEADLESS_POLICY_AUD` (the new app's AUD, not the email app's) and carries a `common_name` from `MCP_HEADLESS_SERVICE_TOKEN_CLIENT_IDS`; (b) an `oseo_` key (Bearer or `x-api-key`) whose SHA-256 is in `OPENSEO_MCP_API_KEYS`, bound to one existing user id. |

After both gates the request runs the same self-host MCP server as `/mcp`,
as Bryan's user (`c405dd23-…`, bryan@bryanrivera.ai) in the shared
workspace. The request path is rewritten to `/mcp` before it reaches the
MCP handler, so tool behavior is identical.

### Why not a path app on `/mcp` itself

A path app on exactly `seo.bryanrivera.ai/mcp` is more specific than the
email app, so it would take over every `/mcp` request:

- Bryan's interactive MCP (Managed OAuth on the email app) would stop
  working unless the new app also carried the email policy and Managed OAuth.
- Requests through it would carry the new app's AUD, which the worker
  rejects today (`POLICY_AUD` mismatch), so creating it before a deploy would
  break `/mcp` for Bryan right away.

`/mcp/headless` leaves the email app, its policy `7fd5c3ea-…` and Managed
OAuth on `/mcp` untouched. Nothing about the interactive path changes.

### Fail-closed behavior

| Condition | Response |
|---|---|
| `MCP_HEADLESS_POLICY_AUD`, `TEAM_DOMAIN` or `OPENSEO_MCP_API_KEYS` unset | 404 (feature off) |
| No / bad / wrong-AUD Access JWT, or JWT without an allowed `common_name` (for example Bryan's browser JWT from the email app on workers.dev) | 403 `{"error":"access_denied"}` |
| Key missing, not `oseo_`, too long or not in the hash list | 401 `{"error":"invalid_api_key"}` |
| Key is valid but the bound user row is gone | 401 `{"error":"invalid_api_key"}` |
| Anything else thrown | 500 `{"error":"internal_error"}` |

The handler never creates users (unlike `ensureUserRecord` on first login).

### Key format and storage

- Key: `oseo_` + 64 hex chars (`openssl rand -hex 32`). The prefix matches the
  hosted convention so secret scanners and humans can tell what it is.
- Worker secret `OPENSEO_MCP_API_KEYS` = `sha256hex:userId[,sha256hex:userId]`.
  The worker only holds the hash. A leaked Worker secret is not a usable key.
- The raw key lives only in Vercel `vps-secrets` as `OPENSEO_MCP_API_KEY`,
  pulled into `~/.claude/.env` by `pai-env-pull.sh --apply`.
- Compare: SHA-256 the presented key, constant-time compare against every
  configured hash (`timingSafeEqual`, no early exit).

### New worker env (all via `.env.selfhost` → `alchemy.run.ts`)

| Name | Kind | Value |
|---|---|---|
| `OPENSEO_MCP_API_KEYS` | secret | `sha256(key):c405dd23-49d9-5d3c-82de-c292d46c46fe` |
| `MCP_HEADLESS_POLICY_AUD` | var | AUD tag of the new path app |
| `MCP_HEADLESS_SERVICE_TOKEN_CLIENT_IDS` | var | client id of `pai-openseo-mcp` (`….access`) |

`TEAM_DOMAIN` is already derived by alchemy for the self-host stage.

## Security trade-offs

- **Blast radius.** The key + token give full MCP power as Bryan: every
  tool, including paid DataForSEO calls (audits with Lighthouse, grids, AI
  visibility). Cost is bounded only by DataForSEO balance. Mitigation: two
  separate secrets are needed, Access keeps it off the public internet, and
  both can be revoked on their own (delete the token from the policy, or drop
  the hash from `OPENSEO_MCP_API_KEYS` and redeploy).
- **No per-key scopes.** Self-host MCP has no read-only scope. A read-only
  mode would be a separate ticket.
- **Rate limit.** The hosted `MCP_RATE_LIMIT` binding is not applied here.
  Single caller, Workers Free daily request cap applies. Acceptable.
- **Expiry.** The service token expires 1 year after creation (8760h).
  Rotate with `POST /access/service_tokens/{id}/rotate`, then update
  `OPENSEO_MCP_CF_ACCESS_CLIENT_SECRET` in vps-secrets. The key has no
  expiry; rotate by generating a new one, swapping the hash and redeploying.
- **Logging.** The handler logs status codes only, never keys, JWTs or hashes.

## Access changes (made in this ticket, safe before deploy)

1. Service token `pai-openseo-mcp` (duration 8760h).
2. Reusable policy `openseo mcp headless service token` (`non_identity`,
   include = that token only).
3. Self-hosted app `open-seo MCP headless (service token)`, domain
   `seo.bryanrivera.ai/mcp/headless`, that policy only, `app_launcher_visible: false`.

Before the deploy, the worker serves `/mcp/headless` with the normal app
router, which rejects the service-token JWT. Nothing new is reachable.
The email app `0f0045d6-…` and its policy are not modified.

## Rollout

1. Merge `PAI-254/headless-mcp` to `main`.
2. In `.env.selfhost` (already staged by this ticket):
   `OPENSEO_MCP_API_KEYS`, `MCP_HEADLESS_POLICY_AUD`,
   `MCP_HEADLESS_SERVICE_TOKEN_CLIENT_IDS`.
3. Deploy from the main checkout (memory `reference_openseo_setup.md`,
   `alchemy deploy --env-file .env.selfhost --stage selfhost --yes`).
   Afterwards confirm the email app still lists both hostnames and the
   `/api/public` and `/mcp/headless` path apps still exist.
4. Smoke test: `~/.claude/scripts/openseo-mcp.sh --list` then
   `openseo-mcp.sh get_audit_status '{"projectId":"c65ed7c9-ee05-4b6d-a61f-8817c7a003ae"}'`.
5. Negative checks: no CF headers → 403 Access page; CF headers + no key →
   401; key + no CF headers → 403; `/mcp` interactive OAuth unchanged.

No migration. No cron. Cost: $0 (only the tools you call spend credits).

## Test plan

Unit (`src/server/mcp/headless-auth.test.ts`), real JWTs signed with a local
key pair via `jose`:

- valid service JWT + valid key → MCP handler runs with Bryan's user id and
  the path rewritten to `/mcp`;
- feature off (no AUD or no keys) → 404;
- missing JWT, wrong AUD (email-app JWT), `common_name` not allowed → 403;
- no key, non-`oseo_` key, unknown key → 401;
- valid key whose user row is missing → 401, no insert;
- key-list parsing drops malformed entries.

Checks: typecheck, vitest, oxlint, `vite build --mode selfhost`.
