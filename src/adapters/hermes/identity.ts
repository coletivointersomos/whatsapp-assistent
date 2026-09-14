import { canonicalJid, jidEquals, jidInList, uniqueJids } from "../../domain/identity.ts";
import type { AuthorRole } from "../../domain/types.ts";
import type { ChannelConfig, ChannelConversation } from "./types.ts";

export function isGroupJid(conversationId: string): boolean {
  return canonicalJid(conversationId).endsWith("@g.us");
}

/** JIDs do motorista principal: config explícita; em 1:1, o próprio chat. */
export function principalDriverJids(
  channel: ChannelConfig,
  conversation: ChannelConversation,
): string[] {
  const fromDrivers = (channel.drivers ?? [])
    .filter((driver) => driver.id === conversation.driverId)
    .flatMap((driver) => driver.jids);
  const inferred = isGroupJid(conversation.conversationId) ? [] : [conversation.conversationId];
  return uniqueJids([...(conversation.driverJids ?? []), ...fromDrivers, ...inferred]);
}

export function resolveChannelAuthorRole(
  authorId: string,
  channel: ChannelConfig,
  conversation: ChannelConversation,
): AuthorRole {
  if (jidInList(authorId, channel.botIds)) return "bot";
  if (jidInList(authorId, channel.adminIds)) return "alana";
  if (principalDriverJids(channel, conversation).some((jid) => jidEquals(jid, authorId))) {
    return "motorista";
  }
  return "desconhecido";
}
