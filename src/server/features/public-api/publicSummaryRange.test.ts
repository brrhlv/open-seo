import { describe, expect, it } from "vitest";
import {
  parsePublicSummaryRange,
  resolvePublicSummaryDates,
} from "./publicSummaryRange";

const NOW = new Date("2026-09-28T12:00:00Z");

describe("parsePublicSummaryRange", () => {
  it("defaults to last_28_days when absent and rejects unsupported values", () => {
    expect(parsePublicSummaryRange(null)).toBe("last_28_days");
    expect(parsePublicSummaryRange("last_90_days")).toBe("last_90_days");
    expect(parsePublicSummaryRange("last_3_months")).toBeNull();
    expect(parsePublicSummaryRange("")).toBeNull();
  });
});

describe("resolvePublicSummaryDates", () => {
  it.each([
    ["last_7_days", "2026-09-19"],
    ["last_28_days", "2026-08-29"],
    ["last_90_days", "2026-06-28"],
  ] as const)(
    "%s covers N inclusive days ending 3 days ago",
    (range, start) => {
      expect(resolvePublicSummaryDates(range, NOW)).toEqual({
        start,
        end: "2026-09-25",
      });
    },
  );
});
