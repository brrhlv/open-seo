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

/** "socialboothlv.com" → "socialboothlv"; "foo.co.uk" → "foo". */
function domainStem(domain: string): string {
  const labels = domain
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".");
  if (labels.length <= 1) return compactName(labels[0] ?? "");
  const last = labels.at(-1) ?? "";
  const secondLast = labels.at(-2) ?? "";
  const drop =
    labels.length >= 3 && last.length === 2 && secondLast.length <= 3 ? 2 : 1;
  return compactName(labels.slice(0, -drop).join(""));
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
  names: string[];
  isTarget: boolean;
};

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
): Map<string, number> {
  const found = new Map<string, number>();
  for (let i = 0; i < words.length; i++) {
    if ((words[i]?.offset ?? 0) < fromOffset) continue;
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
      names: usableNames([
        targetDomain ? domainStem(targetDomain) : null,
        ...(brands.target.names ?? []),
      ]),
      isTarget: true,
    },
    ...brands.competitors
      .filter((c) => c.domain.toLowerCase() !== targetDomain)
      .map((c) => {
        const domain = c.domain.toLowerCase();
        return {
          key: `competitor:${domain}`,
          domain,
          name: c.name ?? null,
          names: usableNames([domainStem(domain), c.name]),
          isTarget: false,
        };
      }),
  ];

  const nameToKey = new Map<string, string>();
  for (const brand of tracked) {
    for (const name of brand.names) {
      if (!nameToKey.has(name)) nameToKey.set(name, brand.key);
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

  for (const [key, offset] of firstNameOffsets(words, nameToKey)) {
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
    const trackedKey = variants
      .map((variant) => nameToKey.get(variant))
      .find(Boolean);
    const located = firstNameOffsets(
      words,
      new Map(variants.map((variant) => [variant, "entity"])),
      previousOffset,
    ).get("entity");
    const offset = located ?? previousOffset;
    previousOffset = offset;
    const key = trackedKey ?? `entity:${variants[0]}`;
    // A tracked brand found by name already has its offset; only fill gaps.
    if (!offsets.has(key)) note(key, offset);
  }

  const ordered = sort(
    [...offsets.entries()].map(([key, offset], index) => ({
      key,
      offset,
      index,
    })),
    (a, b) => a.offset - b.offset || a.index - b.index,
  ).map((entry) => entry.key);
  const positionOf = (key: string) => {
    const index = ordered.indexOf(key);
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
