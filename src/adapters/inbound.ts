import type { InboundMessage } from "../domain/types.ts";

/**
 * Envelope normalizado para o núcleo.
 * Integração Hermes/VPS: etapa futura de comparação/adaptação. Sem cliente fake aqui.
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
