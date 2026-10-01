import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readDateParam, readJsonBody, requireDateParam } from "./reportRequest";

const schema = z.strictObject({ a: z.number() });

function post(body: string) {
  return new Request("https://seo.test/r", { method: "POST", body });
}

describe("readJsonBody", () => {
  it("returns the parsed body", async () => {
    await expect(readJsonBody(post('{"a":1}'), schema)).resolves.toEqual({
      a: 1,
    });
  });

  it("answers 422 for non-JSON", async () => {
    await expect(readJsonBody(post("nope"), schema)).rejects.toMatchObject({
      httpStatus: 422,
      code: "invalid_request",
      extra: { detail: "body must be a JSON object" },
    });
  });

  it("answers 422 naming an unknown top-level key", async () => {
    const error: unknown = await readJsonBody(
      post('{"a":1,"target":"x"}'),
      schema,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ httpStatus: 422, code: "invalid_request" });
    expect(JSON.stringify(error)).toContain("target");
  });
});

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

function at(query: string) {
  return new Request(`https://seo.test/r${query}`);
}

describe("date params", () => {
  it("reads a valid date, null when absent, and rejects impossible dates", () => {
    expect(readDateParam(at("?asOf=2026-09-30"), "asOf")).toBe("2026-09-30");
    expect(readDateParam(at(""), "asOf")).toBeNull();
    expect(
      thrown(() => readDateParam(at("?asOf=2026-02-30"), "asOf")),
    ).toMatchObject({
      httpStatus: 422,
    });
  });

  it("requires a required date", () => {
    expect(thrown(() => requireDateParam(at(""), "asOf"))).toMatchObject({
      httpStatus: 422,
      extra: { detail: "asOf is required (YYYY-MM-DD)" },
    });
  });
});
