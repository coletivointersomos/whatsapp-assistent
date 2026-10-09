import type { AppState, InboundMessage } from "../domain/types.ts";
import { jidEquals } from "../domain/identity.ts";
import { looksLikeGreeting, looksOperationalV2 } from "./fallback.ts";

const WINDOW_MS = 3 * 60 * 1000;

export function nearbyCaption(state: AppState, inbound: InboundMessage): string {
  const own = (inbound.text ?? "").trim();
  if (own) return own;
  const t0 = new Date(inbound.sentAt).getTime();
  if (!Number.isFinite(t0)) return "";
  const recent = state.messages.filter((item) => {
    if (item.conversationId !== inbound.conversationId) return false;
    if (!jidEquals(item.authorId, inbound.authorId)) return false;
    const text = (item.text ?? "").trim();
    if (!text) return false;
    const ts = new Date(item.sentAt).getTime();
    if (!Number.isFinite(ts) || Math.abs(t0 - ts) > WINDOW_MS) return false;
    return true;
  });
  const operational = recent.filter((item) => looksOperationalV2(item.text ?? "", true));
  const pool = operational.length ? operational : recent.filter((item) => !looksLikeGreeting(item.text ?? ""));
  const last = pool.at(-1);
  return (last?.text ?? "").trim();
}
