import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import type { ServiceAccountKey } from "./serviceAccountKey";

// PAI-252: the OAuth 2.0 JWT-bearer flow for a service account, on Web Crypto
// (jose) so it runs in the Worker. No `sub` claim: this account reads only
// what customers shared with it, it never impersonates anyone.
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ASSERTION_LIFETIME_SECONDS = 3600;
// Mint a fresh token this long before the cached one expires.
const REFRESH_MARGIN_MS = 5 * 60_000;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});
const tokenErrorSchema = z.object({ error: z.string() });

export class ServiceAccountTokenError extends Error {
  constructor(
    message: string,
    /** HTTP status from the token endpoint; null when it was not reached. */
    public readonly status: number | null,
    /** Google's `error` code, e.g. "invalid_grant". */
    public readonly googleError: string | null = null,
  ) {
    super(message);
    this.name = "ServiceAccountTokenError";
  }
}

export async function signServiceAccountAssertion(
  key: ServiceAccountKey,
  scope: string,
  issuedAtSeconds: number,
  privateKey?: CryptoKey,
): Promise<string> {
  const signingKey =
    privateKey ?? (await importPKCS8(key.privateKeyPem, "RS256"));
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: key.privateKeyId })
    .setIssuer(key.clientEmail)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(issuedAtSeconds + ASSERTION_LIFETIME_SECONDS)
    .sign(signingKey);
}

type CachedToken = { token: string; expiresAtMs: number };

/** Access tokens per scope for one service account, cached until five
 *  minutes before expiry, one mint in flight per scope. Keys are tried in
 *  order; only a key Google rejects (400/401: deleted or disabled during a
 *  rotation) falls through to the next one. */
export function createServiceAccountTokenSource(
  keys: ServiceAccountKey[],
  now: () => number = Date.now,
) {
  const cached = new Map<string, CachedToken>();
  const inFlight = new Map<string, Promise<string>>();
  const importedKeys = new Map<string, Promise<CryptoKey>>();

  function importedKey(key: ServiceAccountKey) {
    let imported = importedKeys.get(key.privateKeyId);
    if (!imported) {
      imported = importPKCS8(key.privateKeyPem, "RS256");
      importedKeys.set(key.privateKeyId, imported);
    }
    return imported;
  }

  async function exchange(
    key: ServiceAccountKey,
    scope: string,
  ): Promise<CachedToken> {
    const startedAtMs = now();
    const assertion = await signServiceAccountAssertion(
      key,
      scope,
      Math.floor(startedAtMs / 1000),
      await importedKey(key),
    );
    let response: Response;
    try {
      response = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }),
      });
    } catch {
      throw new ServiceAccountTokenError(
        "Google's token endpoint is unreachable.",
        null,
      );
    }
    const body: unknown = await response.json().catch(() => null);
    const parsed = tokenResponseSchema.safeParse(body);
    if (!response.ok || !parsed.success) {
      const googleError = tokenErrorSchema.safeParse(body).data?.error ?? null;
      throw new ServiceAccountTokenError(
        `Google rejected the service-account token request (${response.status}${googleError ? ` ${googleError}` : ""}).`,
        response.status,
        googleError,
      );
    }
    return {
      token: parsed.data.access_token,
      expiresAtMs: startedAtMs + parsed.data.expires_in * 1000,
    };
  }

  async function mint(scope: string): Promise<CachedToken> {
    let lastError: unknown = new ServiceAccountTokenError(
      "No Google service-account key is configured.",
      null,
    );
    for (const key of keys) {
      try {
        return await exchange(key, scope);
      } catch (error) {
        lastError = error;
        const keyRejected =
          error instanceof ServiceAccountTokenError &&
          (error.status === 400 || error.status === 401);
        if (!keyRejected) throw error;
      }
    }
    throw lastError;
  }

  return {
    email: keys[0]?.clientEmail ?? null,

    getAccessToken(scope: string): Promise<string> {
      const hit = cached.get(scope);
      if (hit && hit.expiresAtMs - now() > REFRESH_MARGIN_MS) {
        return Promise.resolve(hit.token);
      }
      const pending = inFlight.get(scope);
      if (pending) return pending;
      const minted = mint(scope)
        .then((token) => {
          cached.set(scope, token);
          return token.token;
        })
        .finally(() => inFlight.delete(scope));
      inFlight.set(scope, minted);
      return minted;
    },
  };
}

export type ServiceAccountTokenSource = ReturnType<
  typeof createServiceAccountTokenSource
>;
