import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

// PAI-252: a dedicated Google service account (not the domain-wide-delegation
// one) reads Search Console and GA4 for properties a customer shared with its
// e-mail. The JSON key file lives base64-encoded in a Worker secret. A second
// secret holds the other key during rotation; both must belong to the same
// service account.
export const GOOGLE_SA_KEY_ENV = "GOOGLE_SA_KEY_JSON_B64";
export const GOOGLE_SA_KEY_SECONDARY_ENV = "GOOGLE_SA_KEY_JSON_B64_SECONDARY";

const serviceAccountKeySchema = z.object({
  type: z.literal("service_account"),
  client_email: z.string().email(),
  private_key: z.string().includes("PRIVATE KEY"),
  private_key_id: z.string().min(1),
});

export type ServiceAccountKey = {
  clientEmail: string;
  privateKeyPem: string;
  privateKeyId: string;
};

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** A key from its secret value: base64 of the JSON key file (raw JSON is
 *  accepted too). Returns null for anything that is not a service-account key;
 *  never logs the value. */
export function parseServiceAccountKey(
  raw: string | undefined,
): ServiceAccountKey | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let json: unknown;
  try {
    json = JSON.parse(
      trimmed.startsWith("{") ? trimmed : decodeBase64Utf8(trimmed),
    );
  } catch {
    return null;
  }
  const parsed = serviceAccountKeySchema.safeParse(json);
  if (!parsed.success) return null;
  return {
    clientEmail: parsed.data.client_email,
    privateKeyPem: parsed.data.private_key,
    privateKeyId: parsed.data.private_key_id,
  };
}

/** The configured keys, primary first. A secondary key for a different
 *  service account is dropped: rotation never changes the e-mail customers
 *  added to their properties. */
export async function loadServiceAccountKeys(): Promise<ServiceAccountKey[]> {
  const primary = parseServiceAccountKey(
    await getOptionalEnvValue(GOOGLE_SA_KEY_ENV),
  );
  const secondary = parseServiceAccountKey(
    await getOptionalEnvValue(GOOGLE_SA_KEY_SECONDARY_ENV),
  );
  const keys = [primary, secondary].filter(
    (key): key is ServiceAccountKey => key !== null,
  );
  const [first, ...rest] = keys;
  if (!first) return [];
  const sameAccount = rest.filter(
    (key) => key.clientEmail === first.clientEmail,
  );
  if (sameAccount.length !== rest.length) {
    console.warn(
      "[google-sa] ignored a secondary key for a different service account",
    );
  }
  return [first, ...sameAccount];
}
