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
  /** Padrão: planilhas (comportamento anterior). Drive passa o escopo dele. */
  scope?: string;
}): string {
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const exp = nowSec + (input.lifetimeSec ?? 3600);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: input.clientEmail,
      scope: input.scope ?? SHEETS_SCOPE,
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
  scope?: string,
): Promise<string> {
  const email = account.client_email?.trim();
  const key = account.private_key?.replace(/\\n/g, "\n");
  if (!email || !key) throw new Error("service account JSON missing client_email or private_key");
  const assertion = signServiceAccountJwt({ clientEmail: email, privateKey: key, scope });
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  const raw = await response.text();
  if (!response.ok) {
    let detail = "";
    try {
      const parsed = JSON.parse(raw) as { error?: string; error_description?: string };
      detail = [parsed.error, parsed.error_description].filter(Boolean).join(" ");
    } catch {
      detail = raw.replace(/\s+/g, " ").slice(0, 80);
    }
    const safe = detail.replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+/g, "[email]").slice(0, 140);
    throw new Error(`google token http ${response.status}${safe ? `: ${safe}` : ""}`);
  }
  let parsed: { access_token?: string };
  try {
    parsed = JSON.parse(raw) as { access_token?: string };
  } catch {
    throw new Error("google token json invalid");
  }
  if (!parsed.access_token) throw new Error("google token missing access_token");
  return parsed.access_token;
}
