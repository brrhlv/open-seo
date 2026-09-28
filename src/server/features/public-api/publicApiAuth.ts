import { timingSafeEqual } from "@/server/lib/timingSafeEqual";

type PublicApiKey = { key: string; projectId: string };

// Keys are generated with `openssl rand -hex 32` (64 chars); refuse anything
// short enough to be guessable so a typo'd secret fails closed.
const MIN_KEY_LENGTH = 32;

/** OPENSEO_PUBLIC_API_KEYS = "key:projectId[,key:projectId]". Entries missing
 *  either half, or with a short key, are ignored. */
export function parsePublicApiKeys(raw: string | undefined): PublicApiKey[] {
  if (!raw) return [];
  const keys: PublicApiKey[] = [];
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf(":");
    if (separator < 0) continue;
    const key = entry.slice(0, separator).trim();
    const projectId = entry.slice(separator + 1).trim();
    if (key.length < MIN_KEY_LENGTH || !projectId) continue;
    keys.push({ key, projectId });
  }
  return keys;
}

/** Keys presented on the request, in order: `Authorization: Bearer <key>`,
 *  then `X-OpenSEO-Key: <key>`. The consumer sends both (PAI-222 contract). */
export function resolvePresentedKeys(headers: Headers): string[] {
  const presented: string[] = [];
  const bearer = /^Bearer\s+(\S+)$/i.exec(
    headers.get("authorization")?.trim() ?? "",
  )?.[1];
  if (bearer) presented.push(bearer);
  const headerKey = headers.get("x-openseo-key")?.trim();
  if (headerKey) presented.push(headerKey);
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
