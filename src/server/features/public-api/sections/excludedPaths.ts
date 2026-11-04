// CLIENT-SBLV-197: paths that are never landing pages or search
// opportunities: the site's own admin, API and sign-in routes. On SBLV the
// root layout used to load GTM on /admin, so GA4 counted /admin/login as an
// organic landing page. One default list for every project.
const EXCLUDED_PATH_PREFIXES = ["/admin", "/api", "/sign-in", "/sign-up"];

/** True for a path, or a full URL, under an excluded prefix. */
export function isExcludedPath(pathOrUrl: string): boolean {
  let path = pathOrUrl;
  if (/^https?:\/\//i.test(pathOrUrl)) {
    try {
      path = new URL(pathOrUrl).pathname;
    } catch {
      return false;
    }
  }
  path = (path.split("?")[0] ?? "").toLowerCase();
  return EXCLUDED_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}
