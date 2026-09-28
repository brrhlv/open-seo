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
