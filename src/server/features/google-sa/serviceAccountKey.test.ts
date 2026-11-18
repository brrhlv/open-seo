import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_SA_KEY_ENV,
  GOOGLE_SA_KEY_SECONDARY_ENV,
  loadServiceAccountKeys,
  parseServiceAccountKey,
} from "./serviceAccountKey";

vi.mock("cloudflare:workers", () => ({ env: {} }));

function keyFile(email: string, id: string) {
  return {
    type: "service_account",
    client_email: email,
    private_key:
      "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
    private_key_id: id,
  };
}

const b64 = (value: unknown) => btoa(JSON.stringify(value));

describe("service-account keys", () => {
  it("reads a base64 key file and rejects anything that is not a service account", () => {
    expect(
      parseServiceAccountKey(
        b64(keyFile("sa@p.iam.gserviceaccount.com", "k1")),
      ),
    ).toMatchObject({
      clientEmail: "sa@p.iam.gserviceaccount.com",
      privateKeyId: "k1",
    });
    expect(
      parseServiceAccountKey(
        b64({ ...keyFile("x@p.iam.gserviceaccount.com", "k"), type: "user" }),
      ),
    ).toBeNull();
    expect(parseServiceAccountKey("not base64 !!")).toBeNull();
  });

  it("drops a secondary key for a different service account", async () => {
    vi.stubEnv(
      GOOGLE_SA_KEY_ENV,
      b64(keyFile("a@p.iam.gserviceaccount.com", "k1")),
    );
    vi.stubEnv(
      GOOGLE_SA_KEY_SECONDARY_ENV,
      b64(keyFile("b@p.iam.gserviceaccount.com", "k2")),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const keys = await loadServiceAccountKeys();

    expect(keys.map((key) => key.privateKeyId)).toEqual(["k1"]);
    vi.unstubAllEnvs();
  });
});
