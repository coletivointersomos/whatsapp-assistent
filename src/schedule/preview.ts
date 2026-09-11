import { seedState } from "../config/seed.ts";
import { isPauseActive, isSuspensionCovering } from "../domain/rules.ts";
import type { AppState } from "../domain/types.ts";

export type ScheduleAction =
  | "enviar coleta diária"
  | "enviar pergunta de pendência existente"
  | "não enviar, suspensão ativa"
  | "não enviar, conversa pausada";

export type ScheduleLine = {
  driverId: string;
  driverName: string;
  action: ScheduleAction;
};

function driverConversation(state: AppState, driverId: string) {
  return state.conversations.find(
    (c) => c.role === "motorista" && c.active && c.driverId === driverId,
  );
}

function suspensionActive(state: AppState, driverId: string, now: Date): boolean {
  return state.suspensions.some((s) =>
    isSuspensionCovering(s.start, s.end, now, s.status) && s.driverId === driverId,
  );
}

function pauseActive(state: AppState, conversationId: string, now: Date): boolean {
  const pause = state.pauses.find((p) => p.conversationId === conversationId);
  return Boolean(pause && isPauseActive(pause.silenceUntil, now));
}

function hasOpenPending(state: AppState, driverId: string): boolean {
  return state.records.some((r) => r.driverId === driverId && r.status === "incompleto");
}

export function scheduleDecisions(state: AppState, now: Date): ScheduleLine[] {
  const lines: ScheduleLine[] = [];
  for (const driver of state.drivers) {
    const conv = driverConversation(state, driver.id);
    if (!conv) continue;
    if (suspensionActive(state, driver.id, now)) {
      lines.push({
        driverId: driver.id,
        driverName: driver.name,
        action: "não enviar, suspensão ativa",
      });
      continue;
    }
    if (pauseActive(state, conv.id, now)) {
      lines.push({
        driverId: driver.id,
        driverName: driver.name,
        action: "não enviar, conversa pausada",
      });
      continue;
    }
    if (hasOpenPending(state, driver.id)) {
      lines.push({
        driverId: driver.id,
        driverName: driver.name,
        action: "enviar pergunta de pendência existente",
      });
      continue;
    }
    lines.push({
      driverId: driver.id,
      driverName: driver.name,
      action: "enviar coleta diária",
    });
  }
  return lines;
}

export function formatSchedulePreview(lines: ScheduleLine[], now: Date, source: string): string {
  const header = `Agora (simulado): ${now.toISOString()}\nFonte: ${source}`;
  const body = lines.map((l) => `- ${l.driverName}: ${l.action}.`).join("\n");
  return `${header}\n${body}\n`;
}

/** Estado demo previsível: João recebe coleta; Ana está suspensa. */
export function scheduleDemoState(): AppState {
  const state = seedState();
  state.suspensions.push({
    id: "sus-demo-ana",
    driverId: "motorista-ana",
    start: "2026-09-10",
    end: "2026-09-15",
    authorId: "alana",
    status: "aplicada",
    commandText: "demo",
    messageId: "demo-sus-ana",
  });
  return state;
}

export const SCHEDULE_DEMO_NOW = new Date("2026-09-12T12:00:00.000Z");
