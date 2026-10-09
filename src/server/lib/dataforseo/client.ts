import {
  type CreditFeature,
  mapDataforseoPathToCreditFeature,
} from "@/shared/billing-credit-features";
import {
  assertUsageCreditsAvailable,
  getOrCreateOrganizationCustomer,
  trackUsageCreditSpend,
} from "@/server/billing/subscription";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  DataforseoChargedTaskError,
  type DataforseoApiCallCost,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import {
  fetchBusinessListingsSearch,
  fetchMyBusinessInfo,
  fetchQuestionsAnswers,
  postGoogleReviewsTask,
  postMyBusinessUpdatesTask,
} from "@/server/lib/dataforseo/business";
import {
  fetchBacklinksHistory,
  fetchBacklinksRows,
  fetchBacklinksSummary,
  fetchDomainPagesSummary,
  fetchReferringDomains,
} from "@/server/lib/dataforseo/backlinks";
import {
  fetchDomainRankOverview,
  fetchKeywordIdeas,
  fetchKeywordOverview,
  fetchKeywordSuggestions,
  fetchRankedKeywords,
  fetchRelatedKeywords,
  fetchRelevantPages,
  fetchSerpCompetitors,
} from "@/server/lib/dataforseo/labs";
import {
  fetchAdsKeywordIdeas,
  fetchAdsSearchVolume,
} from "@/server/lib/dataforseo/google-ads";
import {
  fetchLiveSerp,
  fetchLocalSerp,
  fetchRankCheckSerp,
  postRankCheckTasks,
} from "@/server/lib/dataforseo/serp";
import { fetchLighthouseResult } from "@/server/lib/dataforseo/lighthouse";
import {
  fetchLlmAggregatedMetrics,
  fetchLlmCrossAggregatedMetrics,
  fetchLlmMentionsSearch,
  fetchLlmResponse,
  fetchLlmTopPages,
} from "@/server/lib/dataforseo/ai";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { AppError } from "@/server/lib/errors";

export { mapDataforseoPathToCreditFeature };

/**
 * Wraps a section fetcher with billing metering. Each entry on the client is
 * `meter(ctx, fetchX, defaultFeature?)`, which returns a function with
 * the fetcher's own input type and resolves to its unwrapped `.data`.
 *
 * `defaultFeature` is the fallback credit feature; a caller can override it per
 * call by passing `creditFeature` in the input (e.g. an MCP tool attributing
 * spend to its own feature). The extra field is ignored by the fetchers, which
 * read named fields rather than spreading the input.
 */
function meter<I, T>(
  ctx: MeterContext,
  fetcher: (input: I) => Promise<DataforseoApiResponse<T>>,
  defaultFeature?: CreditFeature,
): (input: I & { creditFeature?: CreditFeature }) => Promise<T> {
  return (input) =>
    meterDataforseoCall(
      ctx.customer,
      () => observeCost(fetcher(input), ctx.onCost),
      input.creditFeature ?? defaultFeature,
    );
}

type MeterContext = {
  customer: BillingCustomerContext;
  onCost?: (costUsd: number) => void;
};

export type DataforseoClientOptions = {
  /**
   * Called with the provider USD cost of every billed call made through this
   * client, including failed-but-charged tasks. Lets a caller persist what a
   * unit of work actually cost (e.g. AI-visibility snapshots); metering itself
   * is unchanged.
   */
  onCost?: (costUsd: number) => void;
};

async function observeCost<T>(
  pending: Promise<DataforseoApiResponse<T>>,
  onCost: ((costUsd: number) => void) | undefined,
): Promise<DataforseoApiResponse<T>> {
  if (!onCost) return pending;
  try {
    const result = await pending;
    onCost(result.billing.costUsd);
    return result;
  } catch (error) {
    if (error instanceof DataforseoChargedTaskError) {
      onCost(error.billing.costUsd);
    }
    throw error;
  }
}

export function createDataforseoClient(
  customer: BillingCustomerContext,
  options: DataforseoClientOptions = {},
) {
  const ctx: MeterContext = { customer, onCost: options.onCost };
  return {
    business: {
      businessListings: meter(ctx, fetchBusinessListingsSearch, "local_seo"),
      questionsAnswers: meter(ctx, fetchQuestionsAnswers, "local_seo"),
      myBusinessInfo: meter(ctx, fetchMyBusinessInfo, "local_seo"),
      // task_post is where DataForSEO charges; collection runs unmetered
      // through fetchBusinessDataTaskResult (see index.ts).
      reviewsTaskPost: meter(ctx, postGoogleReviewsTask, "local_seo"),
      updatesTaskPost: meter(ctx, postMyBusinessUpdatesTask, "local_seo"),
    },
    backlinks: {
      summary: meter(ctx, fetchBacklinksSummary),
      rows: meter(ctx, fetchBacklinksRows),
      referringDomains: meter(ctx, fetchReferringDomains),
      domainPages: meter(ctx, fetchDomainPagesSummary),
      history: meter(ctx, fetchBacklinksHistory),
    },
    keywords: {
      related: meter(ctx, fetchRelatedKeywords),
      suggestions: meter(ctx, fetchKeywordSuggestions),
      ideas: meter(ctx, fetchKeywordIdeas),
      // Google Ads endpoints for countries Labs doesn't support.
      adsIdeas: meter(ctx, fetchAdsKeywordIdeas),
      adsSearchVolume: meter(ctx, fetchAdsSearchVolume),
    },
    domain: {
      rankOverview: meter(ctx, fetchDomainRankOverview),
      rankedKeywords: meter(ctx, fetchRankedKeywords),
      relevantPages: meter(ctx, fetchRelevantPages),
    },
    serp: {
      live: meter(ctx, fetchLiveSerp),
      rankCheck: meter(ctx, fetchRankCheckSerp, "rank_tracking"),
      // Posts up to 100 queued rank check tasks; one metered charge covers the
      // whole batch (DataForSEO bills task_post at post time, collection is
      // free).
      rankCheckTaskPost: meter(ctx, postRankCheckTasks, "rank_tracking"),
      local: meter(ctx, fetchLocalSerp, "local_seo"),
    },
    labs: {
      // Callers (e.g. the keyword-metrics MCP tool) can attribute the spend to
      // their own feature by passing `creditFeature` in the input; defaults to
      // rank_tracking when omitted.
      keywordOverview: meter(ctx, fetchKeywordOverview, "rank_tracking"),
      serpCompetitors: meter(ctx, fetchSerpCompetitors),
    },
    lighthouse: {
      live: meter(ctx, fetchLighthouseResult),
    },
    aiSearch: {
      mentionsSearch: meter(ctx, fetchLlmMentionsSearch),
      aggregatedMetrics: meter(ctx, fetchLlmAggregatedMetrics),
      topPages: meter(ctx, fetchLlmTopPages),
      crossAggregatedMetrics: meter(ctx, fetchLlmCrossAggregatedMetrics),
      llmResponse: meter(ctx, fetchLlmResponse),
    },
  } as const;
}

async function meterDataforseoCall<T>(
  customer: BillingCustomerContext,
  execute: () => Promise<DataforseoApiResponse<T>>,
  creditFeature?: CreditFeature,
): Promise<T> {
  const isHostedMode = await isHostedServerAuthMode();

  if (!isHostedMode) {
    const result = await execute();
    return result.data;
  }

  const billingCustomer = await getOrCreateOrganizationCustomer(customer);

  const { monthlyRemaining } = await assertUsageCreditsAvailable(
    billingCustomer.id,
  );

  let result: DataforseoApiResponse<T>;
  try {
    result = await execute();
  } catch (error) {
    if (error instanceof DataforseoChargedTaskError) {
      // A malformed request (DataForSEO "Invalid Field: ...") that DataForSEO
      // did not bill returns no value to the customer, so don't charge — surface
      // it as a non-reportable VALIDATION_ERROR. If DataForSEO still billed us
      // (costUsd > 0), fall through to the normal charge + capture path so the
      // spend stays metered and visible instead of silently eaten.
      if (error.isInvalidField && error.billing.costUsd <= 0) {
        throw new AppError("VALIDATION_ERROR", error.message);
      }
      await trackDataforseoCost({
        customer,
        customerId: billingCustomer.id,
        billing: error.billing,
        monthlyRemaining,
        creditFeature,
      });
    }
    throw error;
  }

  await trackDataforseoCost({
    customer,
    customerId: billingCustomer.id,
    billing: result.billing,
    monthlyRemaining,
    creditFeature,
  });

  return result.data;
}

async function trackDataforseoCost(args: {
  customer: BillingCustomerContext;
  customerId: string;
  billing: DataforseoApiCallCost;
  monthlyRemaining: number;
  creditFeature?: CreditFeature;
}) {
  await trackUsageCreditSpend({
    customer: args.customer,
    customerId: args.customerId,
    creditFeature:
      args.creditFeature ?? mapDataforseoPathToCreditFeature(args.billing.path),
    costUsd: args.billing.costUsd,
    monthlyRemaining: args.monthlyRemaining,
    properties: {
      provider: "dataforseo",
      paths: [args.billing.path.join("/")],
      fromCache: false,
    },
  });
}
