import { createHmac, timingSafeEqual } from "node:crypto";

export const HMAC_HEADER_CANDIDATES = ["x-openwa-signature", "x-hub-signature-256"] as const;

function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value) return value;
  }
  return undefined;
}

export function extractProvidedHmac(headers: Record<string, string | undefined>): string | undefined {
  for (const name of HMAC_HEADER_CANDIDATES) {
    const raw = headerValue(headers, name);
    if (raw) return raw.trim();
  }
  return undefined;
}

export function hmacSha256Hex(secret: string, body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function normalizeSignature(value: string): string {
  return value.replace(/^sha256=/i, "").trim().toLowerCase();
}

export function signaturesMatch(provided: string, expectedHex: string): boolean {
  const a = Buffer.from(normalizeSignature(provided), "utf8");
  const b = Buffer.from(expectedHex.toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type HmacCheck =
  | { ok: true }
  | { ok: false; reason: "hmac_required" | "hmac_missing" | "hmac_mismatch" };

export function verifyWebhookHmac(input: {
  required: boolean;
  secret: string;
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
}): HmacCheck {
  if (!input.required) return { ok: true };
  if (!input.secret) return { ok: false, reason: "hmac_required" };
  const provided = extractProvidedHmac(input.headers);
  if (!provided) return { ok: false, reason: "hmac_missing" };
  const expected = hmacSha256Hex(input.secret, input.rawBody);
  if (!signaturesMatch(provided, expected)) return { ok: false, reason: "hmac_mismatch" };
  return { ok: true };
}
