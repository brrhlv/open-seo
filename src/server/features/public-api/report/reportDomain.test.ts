import { describe, expect, it } from "vitest";
import { isUrlWithinDomain, requireProjectDomain } from "./reportDomain";

describe("isUrlWithinDomain", () => {
  it.each([
    ["https://socialboothlv.com/photo-booth", true],
    ["http://socialboothlv.com/", true],
    ["https://www.socialboothlv.com/", true],
    ["https://blog.socialboothlv.com/x?y=1", true],
    ["https://SOCIALBOOTHLV.COM/", true],
    ["https://evilsocialboothlv.com/", false],
    ["https://socialboothlv.com.evil.io/", false],
    ["https://user:pw@socialboothlv.com/", false],
    ["ftp://socialboothlv.com/", false],
    ["javascript:alert(1)", false],
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(isUrlWithinDomain(url, "socialboothlv.com")).toBe(expected);
  });

  it("treats a www. project domain as its bare host", () => {
    expect(
      isUrlWithinDomain("https://socialboothlv.com/", "www.socialboothlv.com"),
    ).toBe(true);
  });
});

describe("requireProjectDomain", () => {
  it("answers 409 no_domain for a project without a domain", () => {
    let error: unknown;
    try {
      requireProjectDomain(null);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ httpStatus: 409, code: "no_domain" });
    expect(requireProjectDomain("socialboothlv.com")).toBe("socialboothlv.com");
  });
});
