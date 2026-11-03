import { describe, expect, it, vi } from "vitest";
import {
  scopedAccessToken,
  withSharedAccessTokens,
} from "./sharedAccessTokens";

describe("scopedAccessToken", () => {
  it("mints once per grant inside a scope, across concurrent callers", async () => {
    const mint = vi.fn(() => Promise.resolve("tok"));
    const tokens = await withSharedAccessTokens(() =>
      Promise.all([
        scopedAccessToken("gsc:u1", mint),
        scopedAccessToken("gsc:u1", mint),
        scopedAccessToken("ga4:u1", mint),
      ]),
    );
    expect(tokens).toEqual(["tok", "tok", "tok"]);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("mints every time outside a scope, and per scope", async () => {
    const mint = vi.fn(() => Promise.resolve("tok"));
    await scopedAccessToken("gsc:u1", mint);
    await scopedAccessToken("gsc:u1", mint);
    await withSharedAccessTokens(() => scopedAccessToken("gsc:u1", mint));
    await withSharedAccessTokens(() => scopedAccessToken("gsc:u1", mint));
    expect(mint).toHaveBeenCalledTimes(4);
  });

  it("does not share a failed mint", async () => {
    const mint = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("revoked"))
      .mockResolvedValueOnce("tok");
    await withSharedAccessTokens(async () => {
      await expect(scopedAccessToken("gsc:u1", mint)).rejects.toThrow(
        "revoked",
      );
      expect(await scopedAccessToken("gsc:u1", mint)).toBe("tok");
    });
  });
});
