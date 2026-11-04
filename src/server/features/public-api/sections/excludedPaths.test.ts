import { describe, expect, it } from "vitest";
import { isExcludedPath } from "./excludedPaths";

describe("isExcludedPath", () => {
  it("drops site-admin, API and auth routes, never public pages", () => {
    for (const path of [
      "/admin",
      "/admin/",
      "/admin/login",
      "/admin/blog/preview/x",
      "/api/leads",
      "/sign-in",
      "/sign-up/verify",
      "https://socialboothlv.com/admin/leads?x=1",
    ]) {
      expect(isExcludedPath(path), path).toBe(true);
    }
    for (const path of [
      "/",
      "/corporate-events",
      "/administration",
      "/blog/admin-tips",
      "https://socialboothlv.com/pricing",
    ]) {
      expect(isExcludedPath(path), path).toBe(false);
    }
  });
});
