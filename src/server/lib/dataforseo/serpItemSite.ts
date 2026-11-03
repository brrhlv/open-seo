import { isValidDomainHost } from "@/shared/researchScope";

// Pure leaf module (no fetch/env imports) so SERP mappers and their tests can
// use the real resolver even where the DataForSEO client is mocked.

function isGoogleRedirectUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const { hostname, pathname } = new URL(url);
    return (
      /^(www\.)?google\.[a-z.]+$/i.test(hostname) &&
      (pathname === "/goto" || pathname === "/url")
    );
  } catch {
    return false;
  }
}

// A path segment we trust to be the real one: URL-safe characters only, and
// not Google's "..." truncation marker.
const BREADCRUMB_PATH_SEGMENT = /^(?!\.+$)[\w.~%-]+$/;

/**
 * Parse a SERP breadcrumb ("https://example.com", "example.com › blog › post")
 * into the site's host and a best-effort URL. Social results carry
 * non-host breadcrumbs ("3 likes", "1.4K+ followers"); those return null.
 */
function parseBreadcrumbSite(
  breadcrumb: string,
): { host: string; url: string } | null {
  const [origin = "", ...segments] = breadcrumb
    .split("›")
    .map((part) => part.trim());
  let parsed: URL;
  try {
    parsed = new URL(
      /^https?:\/\//i.test(origin) ? origin : `https://${origin}`,
    );
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".") || !isValidDomainHost(host)) return null;

  // Google's display segments usually mirror the real path, but it also
  // prettifies and truncates them ("…"), and never shows the query string or
  // a trailing slash. When any segment is not plainly URL-safe the path is
  // ambiguous, so fall back to the host root rather than invent a URL.
  const pathSegments = [...parsed.pathname.split("/"), ...segments].filter(
    Boolean,
  );
  const path = pathSegments.every((segment) =>
    BREADCRUMB_PATH_SEGMENT.test(segment),
  )
    ? pathSegments.join("/")
    : "";
  return { host, url: `${parsed.origin}/${path}` };
}

/**
 * The real site behind a SERP item. Mobile SERPs wrap many organic results in
 * a Google redirect: DataForSEO then reports `domain: "google.com"` and
 * `url: "https://google.com/goto?url=CAES…"`, and the site only appears in
 * `breadcrumb`. For those (and for items with no domain) the host and URL come
 * from the breadcrumb; a wrapper URL is never returned. `domain` is null when
 * no host can be resolved.
 */
export function resolveSerpItemSite(item: {
  domain?: string | null;
  url?: string | null;
  breadcrumb?: string | null;
}): { domain: string | null; url: string | null } {
  const wrapped = isGoogleRedirectUrl(item.url);
  if (item.domain != null && !wrapped) {
    return { domain: item.domain, url: item.url ?? null };
  }
  const site = item.breadcrumb ? parseBreadcrumbSite(item.breadcrumb) : null;
  return {
    domain: site?.host ?? null,
    url: wrapped ? (site?.url ?? null) : (item.url ?? site?.url ?? null),
  };
}
