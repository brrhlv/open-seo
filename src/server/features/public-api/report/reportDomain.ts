import { ReportApiError } from "./reportErrors";

/** The project's stored domain; report routes that target the site
 *  (inspect-url, backlinks) answer 409 `no_domain` without one. */
export function requireProjectDomain(domain: string | null): string {
  if (!domain) throw new ReportApiError(409, "no_domain");
  return domain;
}

function bareHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

/** An http(s) URL, without credentials or an explicit port, whose host is the
 *  project domain or a subdomain of it. The dot-suffix rule (`host.endsWith`)
 *  also accepts www. hosts because `bareHost` strips the leading www. from the
 *  stored domain. The R4 guard: a key can only inspect its own site. */
export function isUrlWithinDomain(value: string, domain: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  // Reject URLs with an explicit non-default port (e.g. :8080).
  if (url.port !== "") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const root = bareHost(domain);
  return host === root || host.endsWith(`.${root}`);
}
