import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";
import type * as Jose from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { handleSelfHostedMcpForIdentity } from "@/server/mcp/transport";

const mocks = vi.hoisted(() => ({
  keySet: undefined as JWTVerifyGetKey | undefined,
  getHostedUser: vi.fn(),
  resolveSharedWorkspaceContext: vi.fn(),
  handleSelfHostedMcpForIdentity:
    vi.fn<typeof handleSelfHostedMcpForIdentity>(),
}));

vi.mock("jose", async (importOriginal) => ({
  ...(await importOriginal<typeof Jose>()),
  // The worker fetches Access's JWKS; tests verify against a local key pair.
  createRemoteJWKSet: (): JWTVerifyGetKey => (header, token) => {
    if (!mocks.keySet) throw new Error("test key set not ready");
    return mocks.keySet(header, token);
  },
}));

vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: { getHostedUser: mocks.getHostedUser },
}));

vi.mock("@/middleware/ensure-user/delegated", () => ({
  resolveSharedWorkspaceContext: mocks.resolveSharedWorkspaceContext,
}));

vi.mock("@/server/mcp/transport", () => ({
  handleSelfHostedMcpForIdentity: mocks.handleSelfHostedMcpForIdentity,
}));

import {
  handleHeadlessMcpRequest,
  parseMcpApiKeys,
} from "@/server/mcp/headless-auth";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "headless-aud";
const CLIENT_ID = "abc123.access";
const KEY = `oseo_${"a1".repeat(32)}`;
const USER_ID = "user-1";

let privateKey: CryptoKey;
let env: Record<string, string>;
const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function accessJwt(
  claims: Record<string, unknown>,
  audience = AUD,
  options: { signer?: CryptoKey; withExp?: boolean } = {},
) {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(TEAM)
    .setAudience(audience)
    .setIssuedAt();
  if (options.withExp !== false) jwt.setExpirationTime("5m");
  return jwt.sign(options.signer ?? privateKey);
}

async function request(input: { jwt?: string | null; key?: string | null }) {
  const headers = new Headers({ "Content-Type": "application/json" });
  const jwt =
    input.jwt === undefined
      ? await accessJwt({ common_name: CLIENT_ID, type: "app", sub: "" })
      : input.jwt;
  if (jwt) headers.set("cf-access-jwt-assertion", jwt);
  const key = input.key === undefined ? KEY : input.key;
  if (key) headers.set("Authorization", `Bearer ${key}`);
  return new Request("https://seo.example.com/mcp/headless?x=1", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  mocks.keySet = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }],
  });
  env = {
    TEAM_DOMAIN: TEAM,
    MCP_HEADLESS_POLICY_AUD: AUD,
    MCP_HEADLESS_SERVICE_TOKEN_CLIENT_IDS: CLIENT_ID,
    OPENSEO_MCP_API_KEYS: `${await sha256Hex(KEY)}:${USER_ID}`,
  };
});

beforeEach(() => {
  mocks.getHostedUser.mockResolvedValue({
    id: USER_ID,
    email: "bryan@example.com",
  });
  mocks.resolveSharedWorkspaceContext.mockResolvedValue({
    userId: USER_ID,
    userEmail: "bryan@example.com",
    organizationId: "shared-workspace",
    role: "owner",
    emailVerified: true,
  });
  mocks.handleSelfHostedMcpForIdentity.mockResolvedValue(
    new Response("mcp ok"),
  );
});

describe("handleHeadlessMcpRequest", () => {
  it("serves MCP as the key's user with the path rewritten to /mcp", async () => {
    const response = await handleHeadlessMcpRequest(
      await request({}),
      env,
      ctx,
    );

    expect(await response.text()).toBe("mcp ok");
    expect(mocks.resolveSharedWorkspaceContext).toHaveBeenCalledWith(
      USER_ID,
      "bryan@example.com",
    );
    const [forwarded, identity] =
      mocks.handleSelfHostedMcpForIdentity.mock.calls[0];
    expect(new URL(forwarded.url).pathname).toBe("/mcp");
    expect(await forwarded.json()).toMatchObject({ method: "tools/list" });
    expect(identity).toMatchObject({ userId: USER_ID });
  });

  it("accepts the key from x-api-key", async () => {
    const req = await request({ key: null });
    req.headers.set("x-api-key", KEY);
    const response = await handleHeadlessMcpRequest(req, env, ctx);
    expect(response.status).toBe(200);
  });

  it.each([
    "MCP_HEADLESS_POLICY_AUD",
    "OPENSEO_MCP_API_KEYS",
    "TEAM_DOMAIN",
    "MCP_HEADLESS_SERVICE_TOKEN_CLIENT_IDS",
  ])("is off (404) when %s is unset", async (name) => {
    const response = await handleHeadlessMcpRequest(
      await request({}),
      { ...env, [name]: "" },
      ctx,
    );
    expect(response.status).toBe(404);
  });

  it("rejects a missing Access JWT", async () => {
    const response = await handleHeadlessMcpRequest(
      await request({ jwt: null }),
      env,
      ctx,
    );
    expect(response.status).toBe(403);
  });

  it("rejects a user JWT from the email app (wrong audience, no common_name)", async () => {
    const jwt = await accessJwt(
      { sub: "user-1", email: "bryan@example.com" },
      "email-app-aud",
    );
    const response = await handleHeadlessMcpRequest(
      await request({ jwt }),
      env,
      ctx,
    );
    expect(response.status).toBe(403);
    expect(mocks.handleSelfHostedMcpForIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["is signed by a key outside the JWKS", { withExp: true, attacker: true }],
    ["has no exp claim", { withExp: false, attacker: false }],
  ])(
    "rejects a service-token JWT that %s",
    async (_label, { withExp, attacker }) => {
      // Same kid as the real key: the attacker hopes for a lax lookup.
      const signer = attacker
        ? (await generateKeyPair("RS256")).privateKey
        : undefined;
      const jwt = await accessJwt({ common_name: CLIENT_ID }, AUD, {
        signer,
        withExp,
      });
      const response = await handleHeadlessMcpRequest(
        await request({ jwt }),
        env,
        ctx,
      );
      expect(response.status).toBe(403);
      expect(mocks.handleSelfHostedMcpForIdentity).not.toHaveBeenCalled();
    },
  );

  it("rejects a service token that is not on the allowlist", async () => {
    const jwt = await accessJwt({ common_name: "other.access" });
    const response = await handleHeadlessMcpRequest(
      await request({ jwt }),
      env,
      ctx,
    );
    expect(response.status).toBe(403);
  });

  it.each([
    ["no key", null],
    ["a non-oseo key", "a1".repeat(32)],
    ["an unknown key", `oseo_${"b2".repeat(32)}`],
  ])("returns 401 for %s", async (_label, key) => {
    const response = await handleHeadlessMcpRequest(
      await request({ key }),
      env,
      ctx,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_api_key" });
  });

  it("returns 401 without creating a user when the bound user is gone", async () => {
    mocks.getHostedUser.mockResolvedValue(undefined);
    const response = await handleHeadlessMcpRequest(
      await request({}),
      env,
      ctx,
    );
    expect(response.status).toBe(401);
    expect(mocks.resolveSharedWorkspaceContext).not.toHaveBeenCalled();
  });
});

describe("parseMcpApiKeys", () => {
  it("keeps hash:userId entries and drops malformed ones", () => {
    const hash = "c".repeat(64);
    expect(
      parseMcpApiKeys(`${hash}:u1, bad, ${"d".repeat(10)}:u2, ${hash}:`),
    ).toEqual([{ hash, userId: "u1" }]);
  });
});
