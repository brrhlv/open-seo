import { loadServiceAccountKeys } from "./serviceAccountKey";
import {
  createServiceAccountTokenSource,
  type ServiceAccountTokenSource,
} from "./serviceAccountToken";

// PAI-252: how a project is "linked via the service account". A
// gsc_connections / ga4_connections row whose account id is this value has no
// Better Auth grant behind it: gscClient and ga4Client mint its token from the
// service-account key instead. Google account ids (OIDC `sub`) are numeric, so
// the value can never collide with a real grant. Every reader of those tables
// (services, report API, MCP tools, crons) works unchanged.
export const GOOGLE_SA_ACCOUNT_ID = "google-service-account";

// Same read-only scopes as the user OAuth path. analytics.readonly covers the
// GA4 Admin API reads (accountSummaries, properties, dataStreams) and the
// Data API runReport.
export const GSC_SA_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";
export const GA4_SA_SCOPE =
  "https://www.googleapis.com/auth/analytics.readonly";

export function isServiceAccountGrant(
  accountId: string | null | undefined,
): boolean {
  return accountId === GOOGLE_SA_ACCOUNT_ID;
}

// Secrets are fixed for an isolate's lifetime (a secret change redeploys), so
// the source and its token cache are built once per isolate.
let tokenSource: Promise<ServiceAccountTokenSource> | null = null;

function getTokenSource(): Promise<ServiceAccountTokenSource> {
  tokenSource ??= loadServiceAccountKeys().then((keys) =>
    createServiceAccountTokenSource(keys),
  );
  return tokenSource;
}

/** The e-mail customers add to Search Console / GA4; null when no key is set. */
export async function getServiceAccountEmail(): Promise<string | null> {
  return (await getTokenSource()).email;
}

export async function getServiceAccountAccessToken(
  scope: string,
): Promise<string> {
  return (await getTokenSource()).getAccessToken(scope);
}

export const SA_GSC_DENIED_MESSAGE =
  "Search Console denied the service account access to this property. Add the service account e-mail as a user on the property in Search Console.";
export const SA_GA4_DENIED_MESSAGE =
  "Google Analytics denied the service account access to this property. Add the service account e-mail as a Viewer on the property.";
