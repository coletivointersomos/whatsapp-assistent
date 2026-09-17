# 08 — Assistente operacional (LLM-first)

**Status:** com `LLM_NLU_ENABLED=true` e provider `llm`, a mensagem autorizada entra primeiro no NLU. Hermes/OpenWA continua só canal. O LLM **não** executa ação, **não** escreve Sheets e **não** faz broadcast.

**Padrão (LLM ligado):** allowlist → `ConversationContext` → LLM JSON → engine valida → ação segura. Parser determinístico é fallback (falha, timeout, JSON inválido, confidence baixa) e normalizador de campos.

**Padrão (LLM desligado):** pipeline atual fake/local/determinístico, sem `fetch`.

## 1. Fluidez não vem de formulário regex

O LLM interpreta intenção. O engine pergunta o que falta (em despesa, valor antes de data). Não inventar data.

## 2. O que o código faz vs o que o LLM faz

| Camada | Responsabilidade |
|---|---|
| LLM / NLU | Intenção, `action`, `fields` sugeridos, `reply` |
| Extract | Normalizar número/data/posto a partir do texto |
| Engine | Permissão, criar/completar registro, status, recusar Sheets/broadcast, send gate |

O LLM **não** chama ferramenta, **não** envia WhatsApp, **não** escreve store sozinho.

## 3. ConversationContext

Payload com JIDs mascarados: papel, pausa, permissões (`canWriteSheets`/`canBroadcast` false), motorista, pendências com `record_id`, viagem, status, totais do dia.

## 4. Intents e actions

Intents: `record_event`, `complete_record`, `admin_question`, `sheet_summary_request`, `sheet_change_request`, `broadcast_request`, `ask_driver_followup`, `driver_status_update`, `trip_status_question`, `bot_identity_question`, `operational_summary_request`, `unknown`.

Actions: `create_record`, `update_record`, `complete_record`, `store_status_update`, `answer_question`, `sheet_summary`, `sheet_change_request`, `broadcast_request`, `ask_driver_followup`, `none`, `reply`, `request_confirmation`, `block_sheets`, `block_broadcast`, `unknown`.

Campos: `record_type`, `fields`, `target_record_id`, `reply`, `requiresConfirmation`, `confidence`, `unsafeReason`.

- Sheets real → confirmação; **não escreve**.
- Broadcast → confirmação; **não envia em massa**.

## 5. Status operacional

`parei em Cratos, chuva atrasou` → `store_status_update`. Admin `onde estamos?` usa viagem + última atualização.

## 6. Flags

```
LLM_NLU_ENABLED=false
LLM_NLU_PROVIDER=fake
LLM_NLU_API_KEY=
LLM_NLU_BASE_URL=
```

Só `ENABLED=true` **e** `PROVIDER=llm` **e** key+base URL chamam `/chat/completions` **antes** do parser. Log: `nlu_first`. JSON inválido → fallback determinístico.

## 7. Guard rails

LLM interpreta. Engine executa. Ação sensível pede confirmação. Sheets real off. Broadcast real off.
