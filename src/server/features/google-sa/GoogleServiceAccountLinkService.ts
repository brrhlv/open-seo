import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import { createGa4AdminClient } from "@/server/lib/ga4Client";
import { Ga4AdminApiError, Ga4TokenError } from "@/server/lib/ga4Errors";
import { createGscClient } from "@/server/lib/gscClient";
import { GscApiError, GscTokenError } from "@/server/lib/gscErrors";
import {
  bareHost,
  type Ga4Match,
  matchGa4Properties,
  rankGscSites,
} from "./propertyMatching";
import {
  getServiceAccountEmail,
  GOOGLE_SA_ACCOUNT_ID,
  isServiceAccountGrant,
} from "./serviceAccountGrant";

// BRRHLV-423: link a project's Search Console and GA4 properties through the
// service account with no human step, once the customer has shared them
// with its e-mail. Idempotent: a repeat call with nothing new on Google's side
// writes nothing. A project linked by a person's own Google sign-in keeps that
// link; the service account only fills projects without one.

type Unlinked =
  | { status: "not_configured" | "no_domain" }
  | { status: "not_shared"; message: string }
  | { status: "error"; message: string };

export type GscLinkResult =
  | Unlinked
  | {
      status: "linked";
      siteUrl: string;
      permissionLevel: string;
      changed: boolean;
      /** Other matching properties, best first (not linked). */
      alternatives: string[];
    }
  | { status: "linked_by_user"; siteUrl: string; connectedBy: string | null };

export type Ga4LinkResult =
  | Unlinked
  | {
      status: "linked";
      propertyId: string;
      propertyDisplayName: string;
      streamHost: string;
      measurementId: string | null;
      changed: boolean;
    }
  | {
      status: "linked_by_user";
      propertyId: string;
      connectedBy: string | null;
    }
  | { status: "ambiguous"; candidates: Ga4Match[] };

type GoogleLinkResult = {
  serviceAccountEmail: string | null;
  domain: string | null;
  dryRun: boolean;
  gsc: GscLinkResult;
  ga4: Ga4LinkResult;
};

type LinkInput = {
  projectId: string;
  organizationId: string;
  domain: string | null;
  /** Recorded as connected_by_user_id on the rows this call writes. */
  actorUserId: string;
  /** Report what would be linked without writing. */
  dryRun?: boolean;
};

type ProductContext = LinkInput & { host: string; email: string };

function isGoogleError(error: unknown): error is Error {
  return (
    error instanceof GscApiError ||
    error instanceof GscTokenError ||
    error instanceof Ga4AdminApiError ||
    error instanceof Ga4TokenError
  );
}

async function linkGa4(ctx: ProductContext): Promise<Ga4LinkResult> {
  const existing = await Ga4ConnectionRepository.getByProjectId(ctx.projectId);
  if (existing && !isServiceAccountGrant(existing.ga4AccountId)) {
    return {
      status: "linked_by_user",
      propertyId: existing.propertyId,
      connectedBy: existing.connectedAccountEmail,
    };
  }
  const notShared: Ga4LinkResult = {
    status: "not_shared",
    message: `Add ${ctx.email} as a Viewer on the Google Analytics property for ${ctx.host}.`,
  };
  const client = createGa4AdminClient({
    userId: ctx.actorUserId,
    ga4AccountId: GOOGLE_SA_ACCOUNT_ID,
  });

  const properties = await client.listProperties();
  const withStreams = await Promise.all(
    properties.map(async (property) => ({
      ...property,
      // A property listed but not readable is skipped, not fatal.
      streams: await client
        .listDataStreams(property.propertyId)
        .catch((error: unknown) => {
          if (error instanceof Ga4AdminApiError && error.status === 403) {
            return [];
          }
          throw error;
        }),
    })),
  );
  const matches = matchGa4Properties(ctx.host, withStreams);
  // Several properties with a stream on the domain: keep the one already
  // linked, else leave it for a person to pick rather than guess.
  const chosen =
    matches.length === 1
      ? matches[0]
      : matches.find((match) => match.propertyId === existing?.propertyId);
  if (matches.length === 0) return notShared;
  if (!chosen) return { status: "ambiguous", candidates: matches };

  const changed = existing?.propertyId !== chosen.propertyId;
  let displayName = existing?.propertyDisplayName ?? chosen.displayName;
  if (changed) {
    let property;
    try {
      property = await client.getProperty(chosen.propertyId);
    } catch (error) {
      if (error instanceof Ga4AdminApiError && error.status === 403) {
        return notShared;
      }
      throw error;
    }
    displayName = property.displayName;
    if (!ctx.dryRun) {
      await Ga4ConnectionRepository.upsert({
        projectId: ctx.projectId,
        organizationId: ctx.organizationId,
        propertyId: property.name,
        propertyDisplayName: property.displayName,
        propertyTimeZone: property.timeZone,
        propertyCurrencyCode: property.currencyCode,
        connectedByUserId: ctx.actorUserId,
        ga4AccountId: GOOGLE_SA_ACCOUNT_ID,
        connectedAccountEmail: ctx.email,
      });
    }
  }
  return {
    status: "linked",
    propertyId: chosen.propertyId,
    propertyDisplayName: displayName,
    streamHost: chosen.streamHost,
    measurementId: chosen.measurementId,
    changed,
  };
}

async function linkGsc(
  ctx: ProductContext,
  preferredHost: string | null,
): Promise<GscLinkResult> {
  const existing = await GscConnectionRepository.getByProjectId(ctx.projectId);
  if (existing && !isServiceAccountGrant(existing.gscAccountId)) {
    return {
      status: "linked_by_user",
      siteUrl: existing.siteUrl,
      connectedBy: existing.connectedAccountEmail,
    };
  }
  const client = createGscClient({
    userId: ctx.actorUserId,
    gscAccountId: GOOGLE_SA_ACCOUNT_ID,
  });
  // sites.list only returns properties the account has a permission on, so
  // an unshared property is simply absent.
  const ranked = rankGscSites(
    ctx.host,
    await client.listSites(),
    preferredHost,
  );
  const [best, ...rest] = ranked;
  if (!best) {
    return {
      status: "not_shared",
      message: `Add ${ctx.email} as a user (Restricted is enough) on the Search Console property for ${ctx.host}.`,
    };
  }
  const changed = existing?.siteUrl !== best.siteUrl;
  if (changed && !ctx.dryRun) {
    await GscConnectionRepository.upsert({
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      siteUrl: best.siteUrl,
      connectedByUserId: ctx.actorUserId,
      gscAccountId: GOOGLE_SA_ACCOUNT_ID,
      connectedAccountEmail: ctx.email,
    });
  }
  return {
    status: "linked",
    siteUrl: best.siteUrl,
    permissionLevel: best.permissionLevel,
    changed,
    alternatives: rest.map((site) => site.siteUrl),
  };
}

/** Google failures become an `error` result for that product only, so one
 *  product's outage never blocks linking the other. */
async function settle<T>(
  run: () => Promise<T>,
): Promise<T | { status: "error"; message: string }> {
  try {
    return await run();
  } catch (error) {
    if (isGoogleError(error))
      return { status: "error", message: error.message };
    throw error;
  }
}

async function linkProject(input: LinkInput): Promise<GoogleLinkResult> {
  const dryRun = input.dryRun ?? false;
  const email = await getServiceAccountEmail();
  const host = input.domain ? bareHost(input.domain) : null;
  if (!email || !host) {
    const status = email ? "no_domain" : "not_configured";
    return {
      serviceAccountEmail: email,
      domain: host,
      dryRun,
      gsc: { status },
      ga4: { status },
    };
  }
  const ctx: ProductContext = { ...input, dryRun, host, email };
  // GA4 first: its web stream's host (www or apex) breaks a tie between
  // Search Console URL-prefix properties for the two hosts.
  const ga4 = await settle(() => linkGa4(ctx));
  const gsc = await settle(() =>
    linkGsc(ctx, ga4.status === "linked" ? ga4.streamHost : null),
  );
  return { serviceAccountEmail: email, domain: host, dryRun, gsc, ga4 };
}

export const GoogleServiceAccountLinkService = {
  linkProject,
};
