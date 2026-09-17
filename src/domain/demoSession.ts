import { copyFileSync, existsSync } from "node:fs";
import type { AppState, OperationalRecord } from "./types.ts";

function conversationIds(state: AppState, conversationId: string): Set<string> {
  const ids = new Set<string>([conversationId]);
  const conv = state.conversations.find((c) => c.id === conversationId || c.externalId === conversationId);
  if (conv) {
    ids.add(conv.id);
    ids.add(conv.externalId);
  }
  return ids;
}

function recordTouchesConversation(
  state: AppState,
  record: OperationalRecord,
  conversationId: string,
): boolean {
  const ids = conversationIds(state, conversationId);
  return record.sourceMessageIds.some((id) => {
    const message = state.messages.find((item) => item.externalId === id);
    return Boolean(message && ids.has(message.conversationId));
  });
}

export function applyDemoSessionReset(
  state: AppState,
  conversationId: string,
  startedAt: Date,
): { archived: number; startedAt: string } {
  const iso = startedAt.toISOString();
  let archived = 0;
  for (const record of state.records) {
    if (record.status !== "incompleto" || record.archivedForDemo) continue;
    if (!recordTouchesConversation(state, record, conversationId)) continue;
    record.archivedForDemo = true;
    archived += 1;
  }
  state.demoSession = { conversationId, startedAt: iso };
  return { archived, startedAt: iso };
}

export function backupStoreFile(filePath: string, stamp = new Date()): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const dest = `${filePath}.bak-demo-${stamp.toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(filePath, dest);
  return dest;
}
