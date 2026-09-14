import type { AppState, Conversation, Driver } from "../../domain/types.ts";
import { uniqueJids } from "../../domain/identity.ts";
import type { ChannelConfig } from "./types.ts";

export function applyChannelConfig(state: AppState, channel: ChannelConfig): AppState {
  const conversations: Conversation[] = channel.conversations.map((c) => ({
    id: c.conversationId,
    role: c.role,
    externalId: c.conversationId,
    driverId: c.driverId,
    active: true,
  }));

  const drivers: Driver[] = state.drivers.map((driver) => {
    const extra = channel.drivers?.find((item) => item.id === driver.id);
    const fromConv = channel.conversations
      .filter((c) => c.driverId === driver.id)
      .flatMap((c) => c.driverJids ?? []);
    return {
      ...driver,
      name: extra?.name ?? driver.name,
      vehicleHint: extra?.vehicleHint ?? driver.vehicleHint,
      jids: uniqueJids([...(driver.jids ?? []), ...(extra?.jids ?? []), ...fromConv]),
    };
  });

  for (const extra of channel.drivers ?? []) {
    if (drivers.some((driver) => driver.id === extra.id)) continue;
    drivers.push({
      id: extra.id,
      name: extra.name ?? extra.id,
      vehicleHint: extra.vehicleHint,
      jids: extra.jids,
    });
  }

  const adminId = channel.adminIds[0] ?? state.admin.id;
  return {
    ...state,
    admin: {
      ...state.admin,
      id: adminId,
      jids: channel.adminIds.length ? channel.adminIds : state.admin.jids,
    },
    botIds: channel.botIds,
    drivers,
    conversations,
  };
}
