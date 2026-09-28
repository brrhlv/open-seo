import { describe, expect, it } from "vitest";
import {
  parsePublicApiKeys,
  resolveBoundProjects,
  resolvePresentedKeys,
} from "./publicApiAuth";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("parsePublicApiKeys", () => {
  it("parses key:projectId pairs and drops malformed, short, or unbound entries", () => {
    expect(
      parsePublicApiKeys(
        ` ${KEY_A}:proj-a , ${KEY_B}:proj-b,,nocolon,short:proj-c,${"c".repeat(64)}:`,
      ),
    ).toEqual([
      { key: KEY_A, projectId: "proj-a" },
      { key: KEY_B, projectId: "proj-b" },
    ]);
    expect(parsePublicApiKeys(undefined)).toEqual([]);
  });

  it("drops a key that maps to more than one project (fail closed)", () => {
    const DUPE = "d".repeat(64);
    expect(parsePublicApiKeys(`${DUPE}:proj-x,${DUPE}:proj-y`)).toEqual([]);
    // A unique key alongside a duplicate is kept; the duplicate is dropped.
    expect(
      parsePublicApiKeys(`${DUPE}:proj-x,${DUPE}:proj-y,${KEY_A}:proj-a`),
    ).toEqual([{ key: KEY_A, projectId: "proj-a" }]);
  });

  it("drops keys with embedded whitespace or non-[A-Za-z0-9_-] characters", () => {
    // Embedded space survives trim() and must fail the regex check.
    const WITH_EMBEDDED_SPACE = "a".repeat(16) + " " + "a".repeat(16);
    expect(parsePublicApiKeys(`${WITH_EMBEDDED_SPACE}:proj`)).toEqual([]);
    // Dollar sign is not in the allowed set.
    const WITH_DOLLAR = "$".repeat(64);
    expect(parsePublicApiKeys(`${WITH_DOLLAR}:proj`)).toEqual([]);
  });

  it("handles a project ID that contains colons (first colon splits)", () => {
    const K = "e".repeat(64);
    expect(parsePublicApiKeys(`${K}:org:proj-id`)).toEqual([
      { key: K, projectId: "org:proj-id" },
    ]);
  });
});

describe("resolvePresentedKeys", () => {
  it("reads Bearer first, then X-OpenSEO-Key, ignoring other schemes and blanks", () => {
    expect(
      resolvePresentedKeys(
        new Headers({
          authorization: `Bearer ${KEY_A}`,
          "x-openseo-key": KEY_B,
        }),
      ),
    ).toEqual([KEY_A, KEY_B]);
    expect(
      resolvePresentedKeys(
        new Headers({ authorization: `Basic ${KEY_A}`, "x-openseo-key": " " }),
      ),
    ).toEqual([]);
  });

  it("rejects a presented key longer than 256 chars", () => {
    const LONG = "a".repeat(257);
    expect(
      resolvePresentedKeys(new Headers({ authorization: `Bearer ${LONG}` })),
    ).toEqual([]);
    expect(
      resolvePresentedKeys(new Headers({ "x-openseo-key": LONG })),
    ).toEqual([]);
  });
});

describe("resolveBoundProjects", () => {
  const keys = parsePublicApiKeys(`${KEY_A}:proj-a,${KEY_B}:proj-b`);
  const bound = (headers: Record<string, string>) => [
    ...resolveBoundProjects(new Headers(headers), keys),
  ];

  it("binds a Bearer key or an X-OpenSEO-Key key to its project", () => {
    expect(bound({ authorization: `Bearer ${KEY_B}` })).toEqual(["proj-b"]);
    expect(bound({ "x-openseo-key": KEY_A })).toEqual(["proj-a"]);
  });

  it("accepts either key when both headers are present and disagree", () => {
    expect(
      bound({ authorization: "Bearer wrong", "x-openseo-key": KEY_A }),
    ).toEqual(["proj-a"]);
    expect(
      bound({ authorization: `Bearer ${KEY_A}`, "x-openseo-key": "wrong" }),
    ).toEqual(["proj-a"]);
  });

  it("rejects a multi-value X-OpenSEO-Key header (concatenated with ', ')", () => {
    const h = new Headers();
    h.append("x-openseo-key", KEY_A.slice(0, 32));
    h.append("x-openseo-key", KEY_B.slice(0, 32));
    expect([...resolveBoundProjects(h, keys)]).toEqual([]);
  });

  it("binds correctly when project ID contains colons", () => {
    const K = "e".repeat(64);
    const ks = parsePublicApiKeys(`${K}:org:proj-id`);
    const h = new Headers({ "x-openseo-key": K });
    expect([...resolveBoundProjects(h, ks)]).toEqual(["org:proj-id"]);
  });

  it.each<Record<string, string>>([
    {},
    { authorization: KEY_A },
    { authorization: `Basic ${KEY_A}` },
    { authorization: `Bearer ${KEY_A.slice(1)}` },
    { authorization: `Bearer ${KEY_A}x` },
    { "x-openseo-key": `${KEY_A}x` },
  ])("rejects %j", (headers) => {
    expect(bound(headers)).toEqual([]);
  });
});
