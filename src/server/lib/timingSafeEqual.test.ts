import { describe, expect, it } from "vitest";
import { timingSafeEqual } from "./timingSafeEqual";

describe("timingSafeEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("returns false for different content (same length)", () => {
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("aaa", "aab")).toBe(false);
  });

  it("returns false when left is a prefix of right", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(timingSafeEqual("a", "aa")).toBe(false);
    expect(timingSafeEqual("aa", "a")).toBe(false);
  });
});
