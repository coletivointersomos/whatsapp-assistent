import type { InboundMessage } from "../domain/types.ts";

/**
 * Envelope já no contrato do núcleo. Payloads OpenWA entram por `adapters/hermes`.
 */
export function normalizeInbound(input: InboundMessage): InboundMessage {
  return {
    externalId: input.externalId,
    conversationId: input.conversationId,
    authorId: input.authorId,
    authorRole: input.authorRole,
    sentAt: input.sentAt,
    type: input.type,
    text: input.text,
    attachmentRef: input.attachmentRef,
    raw: input.raw ?? input,
  };
}
