import { createHash } from "node:crypto";

export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 10);
}

/** Máscara para docs/CLI. Não imprime o JID completo. */
export function maskJid(value: string): string {
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed.length <= 12 ? trimmed : `${trimmed.slice(0, 4)}…`;
  const user = trimmed.slice(0, at);
  const server = trimmed.slice(at + 1);
  const tail = user.length >= 4 ? user.slice(-4) : user;
  return `…${tail}@${server}`;
}
