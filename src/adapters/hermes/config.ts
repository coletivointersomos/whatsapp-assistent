import type { AppState, Conversation } from "../../domain/types.ts";
import type { ChannelConfig } from "./types.ts";

export function applyChannelConfig(state: AppState, channel: ChannelConfig): AppState {
  const conversations: Conversation[] = channel.conversations.map((c) => ({
    id: c.conversationId,
    role: c.role,
    externalId: c.conversationId,
    driverId: c.driverId,
    active: true,
  }));
  const adminId = channel.adminIds[0] ?? state.admin.id;
  return {
    ...state,
    admin: { ...state.admin, id: adminId },
    conversations,
  };
}
