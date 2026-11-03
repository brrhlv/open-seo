import { sort } from "remeda";
import {
  dedupe,
  hostOf,
  isIgnoredHost,
  type NormalizedAnswer,
} from "./promptAnswerNormalizers";

export {
  NORMALIZERS,
  normalizeChatGptScraper,
  normalizeGoogleAiMode,
  normalizePerplexity,
  type NormalizedAnswer,
  type PromptPlatform,
} from "./promptAnswerNormalizers";

/**
 * PAI-255: turn one AI platform's answer to a buyer prompt into a result row:
 * was the brand named, at what position among the brands the answer named,
 * which of its pages was cited, and which tracked competitors were named.
 * Pure: the DataForSEO payloads come in, plain values go out. The rules are
 * in docs/specs/PAI-255-ai-visibility-prompts.md ("Answer parsing").
 */

type BrandRef = { domain: string; name?: string | null };

export type PromptCompetitorHit = {
  domain: string;
  name: string | null;
  position: number;
};

type PromptAnalysis = {
  mentioned: boolean;
  position: number | null;
  brandsNamed: number;
  citedUrl: string | null;
  citedUrls: string[];
  competitors: PromptCompetitorHit[];
  excerpt: string | null;
};

const MAX_CITED_URLS = 20;
const MAX_WINDOW_WORDS = 6;
const MIN_COMPACT_NAME = 4;
const EXCERPT_BEFORE = 120;
const EXCERPT_LENGTH = 400;

// Directories and social sites: a link to one is a citation, not a brand.
const AGGREGATOR_STEMS = new Set([
  "yelp",
  "thumbtack",
  "theknot",
  "weddingwire",
  "eventective",
  "bark",
  "partyslate",
  "gigsalad",
  "photoboothlocator",
  "photoboothrentalfinder",
  "facebook",
  "instagram",
  "linkedin",
  "youtube",
  "tiktok",
  "reddit",
  "wikipedia",
  "tripadvisor",
  "google",
  "bing",
  "apple",
  "openai",
  "x",
  "twitter",
  "pinterest",
  "bbb",
  "nextdoor",
  "zola",
  "wikipedia",
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Lowercase alphanumerics only: "Social Booth LV" → "socialboothlv". */
function compactName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * The registrable label of a host: "socialboothlv.com" → "socialboothlv",
 * "m.yelp.com" → "yelp", "en.wikipedia.org" → "wikipedia", "foo.co.uk" →
 * "foo". Subdomains never change the stem.
 */
export function domainStem(domain: string): string {
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 1) return compactName(labels[0] ?? "");
  const last = labels.at(-1) ?? "";
  const secondLast = labels.at(-2) ?? "";
  const twoPartSuffix =
    labels.length >= 3 && last.length === 2 && secondLast.length <= 3;
  return compactName(labels.at(twoPartSuffix ? -3 : -2) ?? "");
}

/** Drops utm_* parameters and a trailing "?" so a cited page reads cleanly. */
function cleanUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (key.toLowerCase().startsWith("utm_")) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

type TrackedBrand = {
  key: string;
  domain: string | null;
  name: string | null;
  /** Matched anywhere in the text as 1–6 consecutive words. */
  names: string[];
  /**
   * A competitor's domain stem (or a name that is only the domain): matched
   * in the text only as one word ("BoothNV"), else by a link or an exact
   * ChatGPT entity, so "lasvegasphotobooth.com" never matches the phrase
   * "Las Vegas photo booth".
   */
  stems: string[];
  isTarget: boolean;
};

/** A stored competitor name that is just its domain ("BoothNV", "x.com"). */
const isDomainDerived = (name: string, stem: string) =>
  !/\s/.test(name.trim()) &&
  compactName(name.replace(/\.[a-z]{2,}$/i, "")) === stem;

function usableNames(values: (string | null | undefined)[]): string[] {
  return dedupe(
    values
      .map((value) => compactName(value ?? ""))
      .filter((value) => value.length >= MIN_COMPACT_NAME),
  );
}

/** Name variants of a ChatGPT entity: "A | tagline", "A (B)". */
function entityVariants(entity: string): string[] {
  const head = entity.split("|")[0] ?? entity;
  const inParens = [...head.matchAll(/\(([^)]+)\)/g)].map((m) => m[1] ?? "");
  const withoutParens = head.replace(/\([^)]*\)/g, " ");
  return usableNames([head, withoutParens, ...inParens]);
}

type Word = { word: string; offset: number };

function wordsOf(text: string): Word[] {
  return [...text.toLowerCase().matchAll(/[a-z0-9]+/g)].map((m) => ({
    word: m[0],
    offset: m.index,
  }));
}

/**
 * First offset at which any of `names` appears as 1–6 consecutive words
 * whose concatenation equals the name exactly ("Social Booth LV" matches
 * "socialboothlv"; "LV Photography" does not match "lvphoto").
 */
function firstNameOffsets(
  words: Word[],
  nameToKey: Map<string, string>,
  fromOffset = 0,
  singleWordToKey: Map<string, string> = new Map(),
): Map<string, number> {
  const found = new Map<string, number>();
  for (let i = 0; i < words.length; i++) {
    if ((words[i]?.offset ?? 0) < fromOffset) continue;
    const single = singleWordToKey.get(words[i]?.word ?? "");
    if (single && !found.has(single)) found.set(single, words[i]?.offset ?? 0);
    let joined = "";
    for (let j = i; j < Math.min(words.length, i + MAX_WINDOW_WORDS); j++) {
      joined += words[j]?.word ?? "";
      const key = nameToKey.get(joined);
      if (key && !found.has(key)) found.set(key, words[i]?.offset ?? 0);
    }
  }
  return found;
}

function excerptAround(text: string, offset: number | null): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (offset === null) {
    return flat.length > EXCERPT_LENGTH
      ? `${flat.slice(0, EXCERPT_LENGTH).trimEnd()}…`
      : flat;
  }
  // Map the offset in `text` onto `flat` by counting the collapsed prefix.
  const prefix = text.slice(0, offset).replace(/\s+/g, " ").trimStart();
  const at = prefix.length;
  const start = Math.max(0, at - EXCERPT_BEFORE);
  const end = Math.min(flat.length, start + EXCERPT_LENGTH);
  const body = flat.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${body}${end < flat.length ? "…" : ""}`;
}

export function analyzeAnswer(
  answer: NormalizedAnswer,
  brands: {
    target: { domain: string | null; names?: string[] };
    competitors: BrandRef[];
  },
): PromptAnalysis {
  const targetDomain = brands.target.domain?.toLowerCase() ?? null;
  const tracked: TrackedBrand[] = [
    {
      key: "target",
      domain: targetDomain,
      name: null,
      // The client's own stem ("Social Booth LV") is trusted as words.
      names: usableNames([
        targetDomain ? domainStem(targetDomain) : null,
        ...(brands.target.names ?? []),
      ]),
      stems: [],
      isTarget: true,
    },
    ...brands.competitors
      .filter((c) => c.domain.toLowerCase() !== targetDomain)
      .map((c) => {
        const domain = c.domain.toLowerCase();
        const stem = domainStem(domain);
        const curated =
          c.name && !isDomainDerived(c.name, stem) ? c.name : null;
        return {
          key: `competitor:${domain}`,
          domain,
          name: c.name ?? null,
          names: usableNames([curated]),
          stems: usableNames([stem]),
          isTarget: false,
        };
      }),
  ];

  const nameToKey = new Map<string, string>();
  const stemToKey = new Map<string, string>();
  for (const brand of tracked) {
    for (const name of brand.names) {
      if (!nameToKey.has(name)) nameToKey.set(name, brand.key);
    }
    for (const stem of brand.stems) {
      if (!stemToKey.has(stem)) stemToKey.set(stem, brand.key);
    }
  }

  // Blank out link targets (same length, so offsets still line up) so a
  // directory URL like thumbtack.com/…/social-booth-lv/ is not a mention.
  const words = wordsOf(
    answer.text.replace(
      /\]\((https?:\/\/[^\s)]+)\)/g,
      (match) => `](${" ".repeat(match.length - 3)})`,
    ),
  );
  // brand key → first offset; insertion order breaks ties.
  const offsets = new Map<string, number>();
  const note = (key: string, offset: number) => {
    const known = offsets.get(key);
    if (known === undefined || offset < known) offsets.set(key, offset);
  };

  for (const [key, offset] of firstNameOffsets(
    words,
    nameToKey,
    0,
    stemToKey,
  )) {
    note(key, offset);
  }

  const trackedByDomain = (host: string) =>
    tracked.find((brand) => brand.domain && hostMatches(host, brand.domain));

  const hasEntities = answer.entities.length > 0;
  for (const link of answer.links) {
    const host = hostOf(link.url);
    if (!host || isIgnoredHost(host)) continue;
    const brand = trackedByDomain(host);
    if (brand) note(brand.key, link.offset);
    else if (!hasEntities && !AGGREGATOR_STEMS.has(domainStem(host))) {
      note(`host:${host}`, link.offset);
    }
  }

  // ChatGPT entities arrive in answer order, so each is looked up from the
  // previous entity on: "Las Vegas Photo" must not match the "Las Vegas photo
  // booth companies" of the opening line. Tracked brands keep their own
  // offset; an entity whose name is not in the text sits after the previous.
  let previousOffset = 0;
  for (const entity of answer.entities) {
    const variants = entityVariants(entity);
    if (variants.length === 0) continue;
    const found = firstNameOffsets(
      words,
      new Map(variants.map((variant) => [variant, "entity"])),
      previousOffset,
    ).get("entity");
    previousOffset = found ?? previousOffset;
    // An exact entity name may also match a competitor's domain stem.
    // (Entity blocks' sources are not used: DataForSEO often attaches a
    // block's sources to the next block, which would merge the wrong brands.)
    const key =
      variants
        .map((variant) => nameToKey.get(variant) ?? stemToKey.get(variant))
        .find(Boolean) ?? `entity:${variants[0]}`;
    note(key, previousOffset);
  }

  const ordered = sort(
    [...offsets.entries()].map(([key, offset], index) => ({
      key,
      offset,
      index,
    })),
    (a, b) => a.offset - b.offset || a.index - b.index,
  ).map((entry) => entry.key);
  // Position counts brands we can name (tracked ones and ChatGPT entities).
  // A bare linked host is often an event venue, a blog or a national chain
  // page, so it counts in brandsNamed but never pushes our position down.
  const ranked = ordered.filter((key) => !key.startsWith("host:"));
  const positionOf = (key: string) => {
    const index = ranked.indexOf(key);
    return index === -1 ? null : index + 1;
  };

  const mentioned = offsets.has("target");
  const citedCandidates = [
    ...answer.links.map((link) => link.url),
    ...answer.sources,
  ];
  const citedUrl = targetDomain
    ? citedCandidates.find((url) => {
        const host = hostOf(url);
        return host !== null && hostMatches(host, targetDomain);
      })
    : undefined;

  const competitors = sort(
    tracked
      .filter((brand) => !brand.isTarget && offsets.has(brand.key))
      .map((brand) => ({
        domain: brand.domain ?? "",
        name: brand.name,
        position: positionOf(brand.key) ?? 0,
      })),
    (a, b) => a.position - b.position,
  );

  return {
    mentioned,
    position: positionOf("target"),
    brandsNamed: ordered.length,
    citedUrl: citedUrl ? cleanUrl(citedUrl) : null,
    citedUrls: dedupe(
      citedCandidates
        .filter((url) => {
          const host = hostOf(url);
          return host !== null && !isIgnoredHost(host);
        })
        .map(cleanUrl),
    ).slice(0, MAX_CITED_URLS),
    competitors,
    excerpt: excerptAround(answer.text, offsets.get("target") ?? null),
  };
}
