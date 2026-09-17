# 08 — Assistente operacional (LLM-first)

**Status chat (agora):** com `ASSISTANT_V2_ENABLED=true` o WhatsApp entra no Assistant V2: conversa livre na mensagem atual; registro só se a mensagem for operacional. Sheets/broadcast continuam bloqueados no chat.

**Status NLU v1 (código ainda no repo):** com `LLM_NLU_ENABLED=true` e provider `llm`, o pipeline antigo interpreta JSON de intents. Não é o caminho do grupo quando o V2 está ligado.

Hermes/OpenWA continua só canal. O LLM **não** executa ação sozinho e **não** faz broadcast.

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
LLM_NLU_MAX_TOKENS=512
```

`max_tokens` padrão **512** (NLU JSON curto). Sem isso, alguns provedores pedem 16k tokens e respondem **402** se o crédito residual for menor. Smoke: `npm run nlu:smoke` (status HTTP + parse; sem secrets). URL: `{base}/chat/completions`, sem duplicar se `base` já termina nesse path. Logs `nlu_http`: status, host, path, bodyPreview mascarado.

Só `ENABLED=true` **e** `PROVIDER=llm` **e** key+base URL chamam `/chat/completions` **antes** do parser. Logs: `nlu_first` e `nlu_result` (intent/action/confidence/hasReply/rejectReason; sem key, HMAC ou JID completo). JSON inválido → fallback determinístico. Se a action for válida, a `reply` do LLM prevalece sobre o template.

## 7. Pausa

Pausa rígida de 15 min **só** se a Alana pedir explicitamente (`deixa comigo`, `pausa o bot`, `não responde agora`, `vou falar com ele`, `estou falando com ele`). Pergunta operacional da admin **não** congela o bot.

## 9. Pendência ativa

Pendência com mais de 30 min não é alvo automático. Novo evento (`nova viagem`, `abasteci`, `teve gasto`, `gastei`) cria registro novo. Complementos curtos (`hoje`, `250 no pix`, `sao joao`) só preenchem pendência **ativa**. Sessão de demo: `npm run demo:reset-session` (backup + `archivedForDemo` no grupo `TEST_GROUP_JID`).

LLM interpreta. Engine executa. Ação sensível pede confirmação. Sheets real off. Broadcast real off.
