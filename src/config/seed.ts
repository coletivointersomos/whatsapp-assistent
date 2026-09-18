import type { AppState } from "../domain/types.ts";

export function seedState(): AppState {
  return {
    admin: { id: "alana", name: "Alana" },
    botIds: [],
    drivers: [
      { id: "motorista-joao", name: "João", vehicleHint: "caminhão 1" },
      { id: "motorista-ana", name: "Ana", vehicleHint: "caminhão 2" },
    ],
    conversations: [
      {
        id: "conv-joao",
        role: "motorista",
        externalId: "conv-joao",
        driverId: "motorista-joao",
        active: true,
      },
      {
        id: "conv-ana",
        role: "motorista",
        externalId: "conv-ana",
        driverId: "motorista-ana",
        active: true,
      },
      {
        id: "conv-central",
        role: "central",
        externalId: "conv-central",
        active: true,
      },
    ],
    messages: [],
    rejected: [],
    records: [],
    pauses: [],
    statusUpdates: [],
    deferrals: [],
    suspensions: [],
    commands: [],
    botReplies: [],
  };
}
