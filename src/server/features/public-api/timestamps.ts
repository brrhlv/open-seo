/** SQLite defaults store "YYYY-MM-DD HH:MM:SS" (UTC); Postgres and app writes
 *  store ISO. The wire contract is ISO. */
export function toIsoTimestamp(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/** Inclusive end-of-day cutoff for an as-of date (YYYY-MM-DD), compared as
 *  text against stored timestamps. ISO values ("…T…Z") on that day sort at or
 *  before it, and so do SQLite "YYYY-MM-DD HH:MM:SS" values (" " < "T"); any
 *  value on the next day sorts after it. */
export function endOfDayCutoff(date: string): string {
  return `${date}T23:59:59.999Z`;
}
