export type SpeechToTextInput = { data: string; mimetype?: string };
export type SpeechToText = { transcribe(input: SpeechToTextInput): Promise<string> };

export type AlibabaAsrConfig = { baseUrl: string; apiKey: string; model: string };

type AsrResponse = {
  sentence?: { text?: unknown };
  output?: { text?: unknown; sentence?: { text?: unknown } };
};

const MAX_BASE64_CHARS = Math.ceil((10 * 1024 * 1024 * 4) / 3);

function cleanBase64(value: string): string {
  return value.replace(/^data:[^;]+;base64,/i, "").replace(/\s/g, "");
}

function audioFormat(mimetype?: string): string {
  const base = (mimetype ?? "audio/ogg").split(";", 1)[0]?.trim().toLowerCase();
  if (base === "audio/ogg") return "ogg";
  if (base === "audio/mpeg") return "mp3";
  if (base === "audio/wav" || base === "audio/x-wav") return "wav";
  if (base === "audio/mp4" || base === "audio/x-m4a") return "mp4";
  if (base === "audio/webm") return "webm";
  if (base === "audio/aac") return "aac";
  if (base === "audio/flac" || base === "audio/x-flac") return "flac";
  return "ogg";
}

function textFrom(response: AsrResponse): string | undefined {
  const candidates = [response.sentence?.text, response.output?.text, response.output?.sentence?.text];
  return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

export function isAlibabaAsrConfigured(config: AlibabaAsrConfig): boolean {
  return Boolean(config.baseUrl && config.apiKey && config.model);
}

/** Transcreve áudio usando o endpoint multimodal do Token Plan/DashScope. */
export function createAlibabaAsr(config: AlibabaAsrConfig, fetchImpl: typeof fetch = fetch): SpeechToText {
  if (!isAlibabaAsrConfigured(config)) throw new Error("asr_not_configured");
  return {
    async transcribe(input) {
      const data = cleanBase64(input.data);
      if (!data) throw new Error("asr_empty_audio");
      if (data.length > MAX_BASE64_CHARS) throw new Error("asr_audio_too_large");
      const mimetype = (input.mimetype ?? "audio/ogg").split(";", 1)[0]?.trim() || "audio/ogg";
      const response = await fetchImpl(config.baseUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          "X-DashScope-SSE": "disable",
        },
        body: JSON.stringify({
          model: config.model,
          input: {
            messages: [
              {
                role: "user",
                content: [{ type: "input_audio", input_audio: { data: `data:${mimetype};base64,${data}` } }],
              },
            ],
          },
          parameters: { format: audioFormat(mimetype), sample_rate: 16_000 },
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error(`asr_request_failed:${response.status}`);
      const transcript = textFrom((await response.json()) as AsrResponse);
      if (!transcript) throw new Error("asr_transcript_missing");
      return transcript;
    },
  };
}
