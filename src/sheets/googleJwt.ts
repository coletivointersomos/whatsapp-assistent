import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function base64Url(value: Buffer | string): string {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function signServiceAccountJwt(input: {
  clientEmail: string;
  privateKey: string;
  nowMs?: number;
  lifetimeSec?: number;
}): string {
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const exp = nowSec + (input.lifetimeSec ?? 3600);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: input.clientEmail,
      scope: SHEETS_SCOPE,
      aud: TOKEN_URL,
      iat: nowSec,
      exp,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(input.privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

export type ServiceAccountFile = {
  client_email?: string;
  private_key?: string;
};

export async function fetchGoogleAccessToken(
  account: ServiceAccountFile,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const email = account.client_email?.trim();
  const key = account.private_key?.replace(/\\n/g, "\n");
  if (!email || !key) throw new Error("service account JSON missing client_email or private_key");
  const assertion = signServiceAccountJwt({ clientEmail: email, privateKey: key });
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth2:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`google token http ${response.status}`);
  let parsed: { access_token?: string };
  try {
    parsed = JSON.parse(raw) as { access_token?: string };
  } catch {
    throw new Error("google token json invalid");
  }
  if (!parsed.access_token) throw new Error("google token missing access_token");
  return parsed.access_token;
}
