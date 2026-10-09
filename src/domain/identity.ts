import type { AppState, AuthorRole, Driver } from "./types.ts";

/** Remove sufixo de device (`123:64@c.us` → `123@c.us`) para comparar participantes. */
export function canonicalJid(value: string): string {
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  const user = trimmed.slice(0, at).split(":")[0];
  const server = trimmed.slice(at + 1);
  return `${user}@${server}`;
}

export function jidEquals(a: string, b: string): boolean {
  return canonicalJid(a) === canonicalJid(b);
}

export function jidInList(jid: string, list: string[] | undefined): boolean {
  return (list ?? []).some((item) => jidEquals(item, jid));
}

export function uniqueJids(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = canonicalJid(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function findDriverByAuthor(state: AppState, authorId: string): Driver | undefined {
  return state.drivers.find(
    (driver) => jidEquals(driver.id, authorId) || jidInList(authorId, driver.jids),
  );
}

export function resolveAuthorRole(state: AppState, authorId: string): AuthorRole {
  if (jidInList(authorId, state.botIds)) return "bot";
  if (jidEquals(authorId, state.admin.id) || jidInList(authorId, state.admin.jids)) return "alana";
  if (findDriverByAuthor(state, authorId)) return "motorista";
  return "desconhecido";
}

export function isPrincipalDriver(
  state: AppState,
  conversationDriverId: string | undefined,
  authorId: string,
): boolean {
  if (!conversationDriverId) return false;
  const driver = findDriverByAuthor(state, authorId);
  if (driver) return driver.id === conversationDriverId;
  return jidEquals(authorId, conversationDriverId);
}
