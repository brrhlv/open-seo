import { AsyncLocalStorage } from "node:async_hooks";

// CLIENT-SBLV-194: one Google access token per grant for a whole request.
// The public summary builds many GSC and GA4 clients (one per call), and
// each used to mint its own token through Better Auth. Inside
// withSharedAccessTokens they share one mint per grant; outside a scope,
// minting is unchanged.

const scope = new AsyncLocalStorage<Map<string, Promise<string>>>();

/** Run `fn` with one access token per grant shared by every client inside it. */
export function withSharedAccessTokens<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run(new Map(), fn);
}

/** The scope's token for `key` (minted once), or a fresh mint outside a scope.
 *  A failed mint is dropped, so a later call can try again. */
export function scopedAccessToken(
  key: string,
  mint: () => Promise<string>,
): Promise<string> {
  const tokens = scope.getStore();
  if (!tokens) return mint();
  const shared = tokens.get(key);
  if (shared) return shared;
  const token = mint();
  tokens.set(key, token);
  token.catch(() => {
    if (tokens.get(key) === token) tokens.delete(key);
  });
  return token;
}
