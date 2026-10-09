import type { InboundMessage, StoredMessage } from "../domain/types.ts";

function stripRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const clone = { ...(raw as Record<string, unknown>) };
  const data = clone.data;
  if (data && typeof data === "object") {
    const dataClone = { ...(data as Record<string, unknown>) };
    const media = dataClone.media;
    if (media && typeof media === "object") {
      const mediaClone = { ...(media as Record<string, unknown>) };
      delete mediaClone.data;
      dataClone.media = mediaClone;
    }
    clone.data = dataClone;
  }
  return clone;
}

/** Não persiste base64 de foto no store.json. */
export function storedWithoutMedia(inbound: InboundMessage, extra: Pick<StoredMessage, "authorRole" | "processedAt">): StoredMessage {
  const { media: _drop, ...rest } = inbound;
  return {
    ...rest,
    authorRole: extra.authorRole,
    participantId: inbound.participantId ?? inbound.authorId,
    processedAt: extra.processedAt,
    raw: stripRaw(inbound.raw),
  };
}
