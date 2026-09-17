import type { AssistantV2Config } from "./types.ts";

export function loadAssistantV2Config(env: NodeJS.Dict<string> = process.env): AssistantV2Config {
  const started = env.ASSISTANT_V2_SESSION_STARTED_AT?.trim();
  return {
    enabled: env.ASSISTANT_V2_ENABLED === "true",
    sessionStartedAt: started || undefined,
  };
}
