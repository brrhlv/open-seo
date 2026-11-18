import {
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ServiceAccountKey } from "./serviceAccountKey";
import {
  createServiceAccountTokenSource,
  GOOGLE_TOKEN_URL,
  ServiceAccountTokenError,
  signServiceAccountAssertion,
} from "./serviceAccountToken";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const fetchMock = vi.fn<typeof fetch>();

let primary: ServiceAccountKey;
let secondary: ServiceAccountKey;
let primaryPublicKey: CryptoKey;

async function makeKey(id: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  return {
    publicKey,
    key: {
      clientEmail: "reader@sa-project.iam.gserviceaccount.com",
      privateKeyPem: await exportPKCS8(privateKey),
      privateKeyId: id,
    },
  };
}

function tokenResponse(token: string, expiresIn = 3600) {
  return Response.json({ access_token: token, expires_in: expiresIn });
}

function sentAssertion(call: number): string {
  const body = fetchMock.mock.calls[call]?.[1]?.body;
  if (!(body instanceof URLSearchParams)) throw new Error("no form body");
  expect(body.get("grant_type")).toBe(
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  );
  return body.get("assertion") ?? "";
}

beforeAll(async () => {
  const first = await makeKey("key-1");
  primary = first.key;
  primaryPublicKey = first.publicKey;
  secondary = (await makeKey("key-2")).key;
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(tokenResponse("tok-1"));
});

afterEach(() => vi.unstubAllGlobals());

describe("signServiceAccountAssertion", () => {
  it("signs an RS256 JWT-bearer assertion Google accepts", async () => {
    const jwt = await signServiceAccountAssertion(
      primary,
      SCOPE,
      1_700_000_000,
    );

    expect(decodeProtectedHeader(jwt)).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: "key-1",
    });
    const { payload } = await jwtVerify(jwt, primaryPublicKey, {
      currentDate: new Date(1_700_000_100_000),
    });
    expect(payload).toEqual({
      iss: primary.clientEmail,
      aud: GOOGLE_TOKEN_URL,
      scope: SCOPE,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
  });
});

describe("createServiceAccountTokenSource", () => {
  it("caches a token per scope until five minutes before it expires", async () => {
    let nowMs = 1_700_000_000_000;
    const source = createServiceAccountTokenSource([primary], () => nowMs);

    const [a, b] = await Promise.all([
      source.getAccessToken(SCOPE),
      source.getAccessToken(SCOPE),
    ]);
    nowMs += 54 * 60_000;
    await expect(source.getAccessToken(SCOPE)).resolves.toBe("tok-1");
    expect([a, b]).toEqual(["tok-1", "tok-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(GOOGLE_TOKEN_URL);

    fetchMock.mockResolvedValue(tokenResponse("tok-2"));
    nowMs += 2 * 60_000;
    await expect(source.getAccessToken(SCOPE)).resolves.toBe("tok-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls through to the secondary key only when Google rejects the primary", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      )
      .mockResolvedValueOnce(tokenResponse("tok-secondary"));
    const source = createServiceAccountTokenSource([primary, secondary]);

    await expect(source.getAccessToken(SCOPE)).resolves.toBe("tok-secondary");
    expect(decodeProtectedHeader(sentAssertion(1)).kid).toBe("key-2");

    fetchMock.mockResolvedValue(new Response("down", { status: 503 }));
    const outage = createServiceAccountTokenSource([primary, secondary]);
    await expect(outage.getAccessToken(SCOPE)).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails without keys and retries after a failed mint", async () => {
    await expect(
      createServiceAccountTokenSource([]).getAccessToken(SCOPE),
    ).rejects.toBeInstanceOf(ServiceAccountTokenError);

    fetchMock.mockRejectedValueOnce(new TypeError("network"));
    const source = createServiceAccountTokenSource([primary]);
    await expect(source.getAccessToken(SCOPE)).rejects.toMatchObject({
      status: null,
    });
    await expect(source.getAccessToken(SCOPE)).resolves.toBe("tok-1");
  });
});
