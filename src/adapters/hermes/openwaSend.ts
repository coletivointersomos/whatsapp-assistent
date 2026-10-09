export type SendTextInput = {
  sessionId: string;
  chatId: string;
  text: string;
};

export type SendTextResult = {
  ok: boolean;
  status?: number;
  skipped?: boolean;
  reason?: string;
};

export type MessageSender = {
  sendText(input: SendTextInput): Promise<SendTextResult>;
};

export function buildOpenWaSendUrl(baseUrl: string, pathTemplate: string, sessionId: string): string {
  const path = pathTemplate.replaceAll("{sessionId}", encodeURIComponent(sessionId));
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ""), base).toString();
}

/** Contrato alinhado ao lab/bridge: POST /api/sessions/{session}/messages/text { chatId, text }. */
export function createOpenWaSender(input: {
  baseUrl: string;
  apiKey: string;
  apiKeyHeader: string;
  sendPath: string;
  fetchImpl?: typeof fetch;
}): MessageSender {
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    async sendText({ sessionId, chatId, text }) {
      const url = buildOpenWaSendUrl(input.baseUrl, input.sendPath, sessionId);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (input.apiKey) headers[input.apiKeyHeader] = input.apiKey;
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ chatId, text }),
      });
      return { ok: response.ok, status: response.status };
    },
  };
}

export function disabledSender(): MessageSender {
  return {
    async sendText() {
      return { ok: true, skipped: true, reason: "live_send_disabled" };
    },
  };
}
