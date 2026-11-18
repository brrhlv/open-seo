import { sort } from "remeda";
import type { GscSite } from "@/server/lib/gscClient";

// BRRHLV-423: which Search Console property and which GA4 property belong to
// a project's domain, picked from everything the service account can see.
// The service account is shared by every customer, so it sees every
// customer's properties: matching is strictly by the project's own domain.

const SITE_UNVERIFIED_PERMISSION = "siteUnverifiedUser";
const WEB_DATA_STREAM = "WEB_DATA_STREAM";

/** Lowercase host without a trailing dot, from a bare domain or a URL. */
function hostOf(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    return url.hostname.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/** hostOf without a leading www. */
export function bareHost(value: string): string | null {
  return hostOf(value)?.replace(/^www\./, "") ?? null;
}

/** Rank of a site for the domain (lower is better), or null when it does not
 *  cover the whole site:
 *  0 sc-domain of the host · 1 sc-domain of a parent domain ·
 *  2-5 a root URL-prefix property on the host or its www. twin, https before
 *  http, the preferred host (the GA4 stream's, else the apex) first.
 *  Sub-path URL-prefix properties (https://example.com/blog/) only cover a
 *  section, so they never match. */
function gscRank(
  site: GscSite,
  host: string,
  preferredHost: string,
): number | null {
  if (site.permissionLevel === SITE_UNVERIFIED_PERMISSION) return null;
  if (site.siteUrl.startsWith("sc-domain:")) {
    const property = site.siteUrl.slice("sc-domain:".length).toLowerCase();
    if (property === host) return 0;
    return host.endsWith(`.${property}`) ? 1 : null;
  }
  let url: URL;
  try {
    url = new URL(site.siteUrl);
  } catch {
    return null;
  }
  if (url.pathname !== "/" || bareHost(url.hostname) !== host) return null;
  const httpPenalty = url.protocol === "https:" ? 0 : 2;
  const hostPenalty = hostOf(url.hostname) === preferredHost ? 0 : 1;
  return 2 + httpPenalty + hostPenalty;
}

/** Search Console properties covering the domain, best first. */
export function rankGscSites(
  domain: string,
  sites: GscSite[],
  preferredHost?: string | null,
): GscSite[] {
  const host = bareHost(domain);
  if (!host) return [];
  const preferred = preferredHost?.toLowerCase() ?? host;
  const matching = sites
    .map((site) => ({ site, rank: gscRank(site, host, preferred) }))
    .filter(
      (entry): entry is { site: GscSite; rank: number } => entry.rank !== null,
    );
  return sort(
    matching,
    (a, b) => a.rank - b.rank || a.site.siteUrl.localeCompare(b.site.siteUrl),
  ).map((entry) => entry.site);
}

export type Ga4PropertyWithStreams = {
  propertyId: string;
  displayName: string;
  streams: Array<{
    type: string;
    webStreamData?: { measurementId?: string; defaultUri?: string };
  }>;
};

export type Ga4Match = {
  propertyId: string;
  displayName: string;
  /** Host of the matching web stream, with www. if the stream has it. */
  streamHost: string;
  measurementId: string | null;
};

/** GA4 properties with a web stream on the domain (www-insensitive). A
 *  property's app streams and web streams for other hosts are ignored. */
export function matchGa4Properties(
  domain: string,
  properties: Ga4PropertyWithStreams[],
): Ga4Match[] {
  const host = bareHost(domain);
  if (!host) return [];
  const matches: Ga4Match[] = [];
  for (const property of properties) {
    for (const stream of property.streams) {
      const uri = stream.webStreamData?.defaultUri;
      if (stream.type !== WEB_DATA_STREAM || !uri) continue;
      const streamHost = hostOf(uri);
      if (!streamHost || bareHost(streamHost) !== host) continue;
      matches.push({
        propertyId: property.propertyId,
        displayName: property.displayName,
        streamHost,
        measurementId: stream.webStreamData?.measurementId ?? null,
      });
      break;
    }
  }
  return matches;
}
