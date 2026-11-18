import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ga4AdminApiError } from "@/server/lib/ga4Errors";
import { GscApiError } from "@/server/lib/gscErrors";
import { GoogleServiceAccountLinkService } from "./GoogleServiceAccountLinkService";
import type * as ServiceAccountGrantModule from "./serviceAccountGrant";
import { GOOGLE_SA_ACCOUNT_ID } from "./serviceAccountGrant";

const SA_EMAIL = "reader@sa-project.iam.gserviceaccount.com";

const mocks = vi.hoisted(() => ({
  getServiceAccountEmail: vi.fn<() => Promise<string | null>>(),
  gscGet: vi.fn(),
  gscUpsert: vi.fn(),
  ga4Get: vi.fn(),
  ga4Upsert: vi.fn(),
  listSites: vi.fn(),
  listProperties: vi.fn(),
  listDataStreams: vi.fn<(propertyId: string) => Promise<unknown[]>>(),
  getProperty: vi.fn(),
  createGscClient: vi.fn(),
  createGa4AdminClient: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("./serviceAccountGrant", async (importOriginal) => ({
  ...(await importOriginal<typeof ServiceAccountGrantModule>()),
  getServiceAccountEmail: mocks.getServiceAccountEmail,
}));
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: {
    getByProjectId: mocks.gscGet,
    upsert: mocks.gscUpsert,
  },
}));
vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: {
    getByProjectId: mocks.ga4Get,
    upsert: mocks.ga4Upsert,
  },
}));
vi.mock("@/server/lib/gscClient", () => ({
  createGscClient: mocks.createGscClient,
}));
vi.mock("@/server/lib/ga4Client", () => ({
  createGa4AdminClient: mocks.createGa4AdminClient,
}));

const input = {
  projectId: "d81a8d9f",
  organizationId: "org-1",
  domain: "boyerlaw.com",
  actorUserId: "user-bryan",
};

const site = (siteUrl: string) => ({
  siteUrl,
  permissionLevel: "siteRestrictedUser",
});
const property = (id: string) => ({
  propertyId: `properties/${id}`,
  displayName: `Property ${id}`,
  accountDisplayName: "Account",
});
const webStream = (defaultUri: string) => [
  { type: "WEB_DATA_STREAM", webStreamData: { defaultUri } },
];

function googleSees(opts: {
  sites: ReturnType<typeof site>[];
  streams: Record<string, string>;
}) {
  mocks.listSites.mockResolvedValue(opts.sites);
  mocks.listProperties.mockResolvedValue(
    Object.keys(opts.streams).map(property),
  );
  mocks.listDataStreams.mockImplementation(async (propertyId) =>
    webStream(opts.streams[propertyId.replace("properties/", "")] ?? ""),
  );
}

beforeEach(() => {
  mocks.getServiceAccountEmail.mockResolvedValue(SA_EMAIL);
  mocks.gscGet.mockResolvedValue(null);
  mocks.ga4Get.mockResolvedValue(null);
  mocks.getProperty.mockImplementation(async (name: string) => ({
    name,
    displayName: "Boyer Law",
    timeZone: "America/Los_Angeles",
    currencyCode: "USD",
  }));
  mocks.createGscClient.mockReturnValue({ listSites: mocks.listSites });
  mocks.createGa4AdminClient.mockReturnValue({
    listProperties: mocks.listProperties,
    listDataStreams: mocks.listDataStreams,
    getProperty: mocks.getProperty,
  });
});

describe("GoogleServiceAccountLinkService.linkProject", () => {
  it("links both properties through the service account, using the GA4 stream host to pick www", async () => {
    googleSees({
      sites: [
        site("https://boyerlaw.com/"),
        site("https://www.boyerlaw.com/"),
        site("sc-domain:other-client.com"),
      ],
      streams: {
        "7": "https://www.boyerlaw.com/",
        "9": "https://other-client.com",
      },
    });

    const result = await GoogleServiceAccountLinkService.linkProject(input);

    expect(result.gsc).toMatchObject({
      status: "linked",
      siteUrl: "https://www.boyerlaw.com/",
      changed: true,
      alternatives: ["https://boyerlaw.com/"],
    });
    expect(result.ga4).toMatchObject({
      status: "linked",
      propertyId: "properties/7",
      streamHost: "www.boyerlaw.com",
    });
    expect(mocks.createGscClient).toHaveBeenCalledWith({
      userId: "user-bryan",
      gscAccountId: GOOGLE_SA_ACCOUNT_ID,
    });
    expect(mocks.gscUpsert).toHaveBeenCalledWith({
      projectId: "d81a8d9f",
      organizationId: "org-1",
      siteUrl: "https://www.boyerlaw.com/",
      connectedByUserId: "user-bryan",
      gscAccountId: GOOGLE_SA_ACCOUNT_ID,
      connectedAccountEmail: SA_EMAIL,
    });
    expect(mocks.ga4Upsert).toHaveBeenCalledWith({
      projectId: "d81a8d9f",
      organizationId: "org-1",
      propertyId: "properties/7",
      propertyDisplayName: "Boyer Law",
      propertyTimeZone: "America/Los_Angeles",
      propertyCurrencyCode: "USD",
      connectedByUserId: "user-bryan",
      ga4AccountId: GOOGLE_SA_ACCOUNT_ID,
      connectedAccountEmail: SA_EMAIL,
    });
  });

  it("keeps a link made with a person's own Google sign-in", async () => {
    mocks.gscGet.mockResolvedValue({
      siteUrl: "sc-domain:boyerlaw.com",
      gscAccountId: "105551234",
      connectedAccountEmail: "taylor@boyerlaw.com",
    });
    mocks.ga4Get.mockResolvedValue({
      propertyId: "properties/7",
      ga4AccountId: "105551234",
      connectedAccountEmail: "taylor@boyerlaw.com",
    });

    const result = await GoogleServiceAccountLinkService.linkProject(input);

    expect(result.gsc.status).toBe("linked_by_user");
    expect(result.ga4.status).toBe("linked_by_user");
    expect(mocks.createGscClient).not.toHaveBeenCalled();
    expect(mocks.createGa4AdminClient).not.toHaveBeenCalled();
  });

  it("tells the caller which e-mail to add when nothing is shared yet or Google answers 403", async () => {
    googleSees({ sites: [], streams: { "7": "https://boyerlaw.com" } });
    mocks.getProperty.mockRejectedValue(new Ga4AdminApiError(403, "denied"));

    const result = await GoogleServiceAccountLinkService.linkProject(input);

    expect(result.gsc).toEqual({
      status: "not_shared",
      message: expect.stringContaining(SA_EMAIL) as unknown,
    });
    expect(result.ga4).toEqual({
      status: "not_shared",
      message: expect.stringContaining(SA_EMAIL) as unknown,
    });
    expect(mocks.gscUpsert).not.toHaveBeenCalled();
    expect(mocks.ga4Upsert).not.toHaveBeenCalled();
  });

  it("writes nothing when relinking an unchanged project", async () => {
    mocks.gscGet.mockResolvedValue({
      siteUrl: "sc-domain:boyerlaw.com",
      gscAccountId: GOOGLE_SA_ACCOUNT_ID,
    });
    mocks.ga4Get.mockResolvedValue({
      propertyId: "properties/7",
      propertyDisplayName: "Boyer Law",
      ga4AccountId: GOOGLE_SA_ACCOUNT_ID,
    });
    googleSees({
      sites: [site("sc-domain:boyerlaw.com"), site("https://boyerlaw.com/")],
      streams: { "7": "https://boyerlaw.com" },
    });

    const result = await GoogleServiceAccountLinkService.linkProject(input);

    expect(result.gsc).toMatchObject({ status: "linked", changed: false });
    expect(result.ga4).toMatchObject({ status: "linked", changed: false });
    expect(mocks.gscUpsert).not.toHaveBeenCalled();
    expect(mocks.ga4Upsert).not.toHaveBeenCalled();
  });

  it("leaves GA4 for a person when two properties stream the domain", async () => {
    googleSees({
      sites: [site("sc-domain:boyerlaw.com")],
      streams: { "7": "https://boyerlaw.com", "8": "https://www.boyerlaw.com" },
    });

    const result = await GoogleServiceAccountLinkService.linkProject(input);

    expect(result.ga4).toMatchObject({ status: "ambiguous" });
    expect(mocks.ga4Upsert).not.toHaveBeenCalled();
    expect(result.gsc).toMatchObject({ status: "linked" });
  });

  it("reports a Google failure per product without blocking the other", async () => {
    googleSees({ sites: [], streams: { "7": "https://boyerlaw.com" } });
    mocks.listSites.mockRejectedValue(
      new GscApiError(403, "Search Console API has not been used"),
    );

    const result = await GoogleServiceAccountLinkService.linkProject(input);

    expect(result.gsc).toEqual({
      status: "error",
      message: "Search Console API has not been used",
    });
    expect(result.ga4).toMatchObject({ status: "linked" });
  });

  it("makes no Google call without a key or a project domain", async () => {
    mocks.getServiceAccountEmail.mockResolvedValueOnce(null);
    const unconfigured =
      await GoogleServiceAccountLinkService.linkProject(input);
    const noDomain = await GoogleServiceAccountLinkService.linkProject({
      ...input,
      domain: null,
    });

    expect(unconfigured.gsc.status).toBe("not_configured");
    expect(noDomain.ga4.status).toBe("no_domain");
    expect(mocks.createGscClient).not.toHaveBeenCalled();
    expect(mocks.createGa4AdminClient).not.toHaveBeenCalled();
  });
});
