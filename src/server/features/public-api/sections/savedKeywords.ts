// The leaf module, not KeywordResearchService: that barrel also pulls in the
// metered research path (DataForSEO client, R2 cache).
import { getSavedKeywords } from "@/server/features/keywords/services/research/saved-keywords";
import { toIsoTimestamp } from "../timestamps";

// CLIENT-SBLV-196: the project's saved keywords (D1 only, no DataForSEO), so
// an external dashboard can turn tagged keywords into work (the SBLV admin's
// blog calendar reads `blog-idea`). The newest saved first, capped; consumers
// filter by tag because the summary is cached per project + range. The cap
// keeps the section small (~36 KB raw at 100 rows) because every summary
// fetch carries it, including the admin dashboard tile with a 5 s timeout.
const SAVED_KEYWORD_LIMIT = 100;

export async function getSavedKeywordsSection(projectId: string) {
  const { rows, totalCount, tags } = await getSavedKeywords({
    projectId,
    page: 1,
    pageSize: SAVED_KEYWORD_LIMIT,
    sort: "createdAt",
    order: "desc",
  });
  return {
    totalCount,
    truncated: totalCount > rows.length,
    tags: tags.map((tag) => ({
      name: tag.name,
      keywordCount: tag.keywordCount,
    })),
    keywords: rows.map((row) => ({
      keyword: row.keyword,
      searchVolume: row.searchVolume,
      keywordDifficulty: row.keywordDifficulty,
      cpc: row.cpc,
      intent: row.intent,
      tags: row.tags.map((tag) => tag.name),
      savedAt: toIsoTimestamp(row.createdAt),
      metricsFetchedAt: toIsoTimestamp(row.fetchedAt),
      locationCode: row.locationCode,
      languageCode: row.languageCode,
    })),
  };
}
