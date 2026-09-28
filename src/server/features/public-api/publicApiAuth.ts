import { timingSafeEqual } from "@/server/lib/timingSafeEqual";

type PublicApiKey = { key: string; projectId: string };

// Keys are generated with `openssl rand -hex 32` (64 chars); refuse anything
// short enough to be guessable so a typo'd secret fails closed.
const MIN_KEY_LENGTH = 32;
// Cap presented-key length so oversized values are skipped before the
// constant-time compare loop runs over a huge buffer.
const MAX_PRESENTED_KEY_LENGTH = 256;
// Keys must be token-safe: hex / base62 / underscore / hyphen only.
// Whitespace, colons, or shell-special chars in a configured key are almost
// always a mis-paste — fail closed at parse time.
const VALID_KEY_RE = /^[A-Za-z0-9_-]+$/;

// Cache parsed key arrays by raw secret string so the warning fires exactly
// once per distinct secret value (Workers restart clears it; that's fine).
const _keyCache = new Map<string, PublicApiKey[]>();

/** OPENSEO_PUBLIC_API_KEYS = "key:projectId[,key:projectId]". Entries missing
 *  either half, with a short key, with invalid key chars, or where the same key
 *  maps to more than one project are silently dropped (fail closed). Logs only
 *  the count of dropped entries, never any values. */
export function parsePublicApiKeys(raw: string | undefined): PublicApiKey[] {
  if (!raw) return [];
  const cached = _keyCache.get(raw);
  if (cached) return cached;
  let dropped = 0;
  const candidates: PublicApiKey[] = [];

  for (const entry of raw.split(",")) {
    const separator = entry.indexOf(":");
    if (separator < 0) {
      dropped++;
      continue;
    }
    const key = entry.slice(0, separator).trim();
    const projectId = entry.slice(separator + 1).trim();
    if (key.length < MIN_KEY_LENGTH || !projectId || !VALID_KEY_RE.test(key)) {
      dropped++;
      continue;
    }
    candidates.push({ key, projectId });
  }

  // Fail closed: a key bound to more than one project is dropped in its entirety.
  const keyCounts = new Map<string, number>();
  for (const { key } of candidates) {
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  const keys: PublicApiKey[] = [];
  for (const entry of candidates) {
    if ((keyCounts.get(entry.key) ?? 0) > 1) {
      dropped++;
    } else {
      keys.push(entry);
    }
  }

  if (dropped > 0) {
    console.warn(
      `[publicApiAuth] parsePublicApiKeys: dropped ${dropped} malformed or duplicate entries`,
    );
  }

  _keyCache.set(raw, keys);
  return keys;
}

/** Keys presented on the request, in order: `Authorization: Bearer <key>`,
 *  then `X-OpenSEO-Key: <key>`. Oversized values (> MAX_PRESENTED_KEY_LENGTH)
 *  are skipped. The consumer sends both (PAI-222 contract). */
export function resolvePresentedKeys(headers: Headers): string[] {
  const presented: string[] = [];
  const bearer = /^Bearer\s+(\S+)$/i.exec(
    headers.get("authorization")?.trim() ?? "",
  )?.[1];
  if (bearer && bearer.length <= MAX_PRESENTED_KEY_LENGTH)
    presented.push(bearer);
  const headerKey = headers.get("x-openseo-key")?.trim();
  if (headerKey && headerKey.length <= MAX_PRESENTED_KEY_LENGTH)
    presented.push(headerKey);
  return presented;
}

/** Projects bound to ANY presented key (so disagreeing headers are accepted
 *  when either one is valid). Every presented key is compared against every
 *  configured key in constant time, with no early exit. */
export function resolveBoundProjects(
  headers: Headers,
  keys: PublicApiKey[],
): Set<string> {
  const projects = new Set<string>();
  for (const presented of resolvePresentedKeys(headers)) {
    for (const entry of keys) {
      if (timingSafeEqual(presented, entry.key)) projects.add(entry.projectId);
    }
  }
  return projects;
}
