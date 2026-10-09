import { seedState } from "../config/seed.ts";
import { processMessage } from "../engine/process.ts";
import type { AppState } from "../domain/types.ts";

/** Estado demo previsível, sem data/store.json e sem Google. */
export function sheetsDemoState(): AppState {
  const state = seedState();
  const messages = [
    {
      externalId: "demo-abast",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista" as const,
      sentAt: "2026-09-09T12:00:00.000Z",
      type: "texto" as const,
      text: "hoje abasteci 200 litros no posto X deu 1200 pago",
    },
    {
      externalId: "demo-despesa",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista" as const,
      sentAt: "2026-09-09T12:10:00.000Z",
      type: "audio_info" as const,
      text: "hoje gastei 150 com almoço pago",
    },
    {
      externalId: "demo-assinada",
      conversationId: "conv-joao",
      authorId: "motorista-joao",
      authorRole: "motorista" as const,
      sentAt: "2026-09-09T12:20:00.000Z",
      type: "texto" as const,
      text: "abasteci 150 litros, deu 980, assinada",
    },
    {
      externalId: "demo-viagem",
      conversationId: "conv-ana",
      authorId: "motorista-ana",
      authorRole: "motorista" as const,
      sentAt: "2026-09-09T13:00:00.000Z",
      type: "texto" as const,
      text: "hoje frete de Barreiras para Recife, soja, 47 m3",
    },
  ];

  for (const message of messages) {
    const sentAt = new Date(message.sentAt);
    processMessage(state, message, { now: () => sentAt });
  }
  return state;
}
