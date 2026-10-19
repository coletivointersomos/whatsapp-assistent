import type { AppState } from "../domain/types.ts";

/**
 * Gatilho automático da escrita append-only (planilha existente do mês).
 *   MODELO_AUTO_FILL_ENABLED=false            (liga/desliga; também exige MODELO_SHEET_ENABLED=true e alvo)
 *   MODELO_AUTO_FILL_CHAT_IDS=<jid do grupo>  (só essas conversas disparam; vazio = nenhuma)
 *   MODELO_AUTO_FILL_DEBOUNCE_MS=60000
 * Fila: agrupa disparos por competência durante a janela, roda UMA execução por vez e, se chegou
 * mensagem durante a execução, agenda outra depois. Erro só vira log; nunca propaga.
 */
export type AutoFillConfig = { enabled: boolean; chatIds: string[]; debounceMs: number };

export function loadAutoFillConfig(env: Record<string, string | undefined> = process.env): AutoFillConfig {
  const ms = Number(env.MODELO_AUTO_FILL_DEBOUNCE_MS);
  return {
    enabled: (env.MODELO_AUTO_FILL_ENABLED === "true" || env.CONVERSA_SHEET_ENABLED === "true") && env.MODELO_SHEET_ENABLED === "true" && Boolean(env.MODELO_TARGET_SPREADSHEET_ID?.trim()),
    chatIds: (env.MODELO_AUTO_FILL_CHAT_IDS ?? "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
    debounceMs: Number.isFinite(ms) && ms >= 1000 ? ms : 60_000,
  };
}

/** Mês do FATO dos registros da mensagem (AAAA-MM); sem fato, mês de hoje em Brasília. */
export function factCompetencia(state: AppState, externalId: string | undefined, now: Date = new Date()): string {
  const date = externalId
    ? state.records
        .filter((r) => r.sourceMessageIds.includes(externalId))
        .map((r) => (r.viagem ?? r.despesa ?? r.abastecimento)?.date)
        .find((d): d is string => Boolean(d && /^\d{4}-\d{2}/.test(d)))
    : undefined;
  return (date ?? new Date(now.getTime() - 3 * 3600_000).toISOString()).slice(0, 7);
}

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void };

export function createAutoFill(input: {
  config: AutoFillConfig;
  run: (competencia: string) => Promise<unknown>;
  log: (event: string, fields?: Record<string, unknown>) => void;
  timers?: Timers;
}) {
  const timers: Timers = input.timers ?? {
    set: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
  const pending = new Set<string>();
  let timer: unknown;
  let running = false;

  async function flush(): Promise<void> {
    timer = undefined;
    if (running) return; // o fim da execução em curso reagenda
    running = true;
    try {
      while (pending.size) {
        const [competencia] = [...pending].sort();
        pending.delete(competencia!);
        try {
          await input.run(competencia!);
          input.log("auto_fill_done", { competencia });
        } catch (error) {
          input.log("auto_fill_failed", { competencia, reason: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    /** Chamado depois de processar a mensagem; síncrono, nunca lança. */
    trigger(chatId: string | undefined, competencia: string): boolean {
      try {
        if (!input.config.enabled || !chatId || !input.config.chatIds.includes(chatId) || !/^\d{4}-\d{2}$/.test(competencia)) return false;
        pending.add(competencia);
        if (!timer && !running) timer = timers.set(() => void flush(), input.config.debounceMs);
        else if (running) input.log("auto_fill_queued", { competencia });
        return true;
      } catch {
        return false;
      }
    },
    flush,
    get state() {
      return { pending: [...pending], running, scheduled: timer !== undefined };
    },
  };
}
