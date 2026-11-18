import { describe, expect, it } from "vitest";
import {
  type Ga4PropertyWithStreams,
  matchGa4Properties,
  rankGscSites,
} from "./propertyMatching";

const site = (siteUrl: string, permissionLevel = "siteRestrictedUser") => ({
  siteUrl,
  permissionLevel,
});

const ranked = (...args: Parameters<typeof rankGscSites>) =>
  rankGscSites(...args).map((s) => s.siteUrl);

describe("rankGscSites", () => {
  it("puts the sc-domain property first and ignores other customers' sites", () => {
    expect(
      ranked("example.com", [
        site("https://www.example.com/"),
        site("sc-domain:other-client.com"),
        site("https://example.com/"),
        site("sc-domain:example.com"),
      ]),
    ).toEqual([
      "sc-domain:example.com",
      "https://example.com/",
      "https://www.example.com/",
    ]);
  });

  it("covers a subdomain project with the parent sc-domain property", () => {
    expect(
      ranked("shop.example.com", [
        site("sc-domain:example.com"),
        site("https://example.com/"),
      ]),
    ).toEqual(["sc-domain:example.com"]);
  });

  it("prefers the apex URL-prefix property unless the GA4 stream is on www", () => {
    const sites = [
      site("http://example.com/"),
      site("https://www.example.com/"),
      site("https://example.com/"),
    ];
    expect(ranked("example.com", sites)[0]).toBe("https://example.com/");
    expect(ranked("www.example.com", sites, "www.example.com")).toEqual([
      "https://www.example.com/",
      "https://example.com/",
      "http://example.com/",
    ]);
  });

  it("never matches unverified access or a sub-path property", () => {
    expect(
      ranked("example.com", [
        site("sc-domain:example.com", "siteUnverifiedUser"),
        site("https://example.com/blog/"),
      ]),
    ).toEqual([]);
  });
});

const web = (defaultUri: string, measurementId = "G-1") => ({
  type: "WEB_DATA_STREAM",
  webStreamData: { defaultUri, measurementId },
});
const property = (
  propertyId: string,
  streams: Ga4PropertyWithStreams["streams"],
) => ({ propertyId, displayName: propertyId, streams });

describe("matchGa4Properties", () => {
  it("picks the property and stream whose web stream host is the domain", () => {
    expect(
      matchGa4Properties("example.com", [
        property("properties/1", [web("https://other-client.com", "G-X")]),
        property("properties/2", [
          { type: "ANDROID_APP_DATA_STREAM" },
          web("https://blog.example.com", "G-BLOG"),
          web("https://www.example.com/", "G-WWW"),
        ]),
      ]),
    ).toEqual([
      {
        propertyId: "properties/2",
        displayName: "properties/2",
        streamHost: "www.example.com",
        measurementId: "G-WWW",
      },
    ]);
  });

  it("returns every matching property so the caller can refuse to guess", () => {
    expect(
      matchGa4Properties("example.com", [
        property("properties/1", [web("https://example.com")]),
        property("properties/2", [web("example.com")]),
        property("properties/3", []),
      ]).map((match) => match.propertyId),
    ).toEqual(["properties/1", "properties/2"]);
  });
});
