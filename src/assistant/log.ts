import { previewReply } from "../nlu/audit.ts";
import type { AssistantResponse } from "./types.ts";

export function safeAssistantLogFields(result: AssistantResponse): Record<string, unknown> {
  const preview = previewReply(result.message);
  return {
    actions_count: result.actions.length,
    action_types: result.actions.map((action) => action.type),
    confidence: result.confidence,
    needsConfirmation: Boolean(result.needsConfirmation),
    message_preview: preview.replyPreview ?? "",
    hasMessage: preview.hasReply,
  };
}
