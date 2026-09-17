# 08 — Assistente operacional (contexto + actions)

**Status:** NLU baseada em contexto. Hermes/OpenWA continua só canal. LLM **não** executa ação, não escreve Sheets e não manda broadcast.  
**Padrão:** parser determinístico primeiro → NLU (fake local ou LLM remoto) devolve JSON (intent, action, reply) → engine valida e executa o que for seguro.

## 1. Fluidez não vem de frases fixas

Não vamos crescer if/else de apresentação (`quem é você?`, `onde estamos?`, `você me escuta?`). Essas perguntas devem ser respondidas com o **contexto da conversa**. O fake provider é o stand-in testável; o LLM real, quando autorizado, usa o mesmo JSON.

Fallback simples (alô / bom dia do motorista, `ajuda` na central) só cobre o caso em que a NLU local está explicitamente desligada (`nluEnabled: false`). O caminho principal é contexto + intenção.

## 2. O que o código faz vs o que o LLM faz

| Camada | Responsabilidade |
|---|---|
| Extract / engine | Registros claros, complemento, pausa, allowlist, send gate |
| NLU | Classificar intent, sugerir `reply` natural, apontar `action` |
| Engine | Validar permissão, gravar status, recusar Sheets/broadcast, perguntar campos |

O LLM **não** chama ferramenta, **não** envia WhatsApp, **não** escreve store sozinho.

## 3. ConversationContext

O payload para o interpretador inclui, quando existir (JIDs só mascarados):

- conversa mascarada, papel, pausa, permissões (`canWriteSheets`/`canBroadcast` sempre false nesta fase);
- motorista e veículo associados;
- últimas mensagens, última pergunta do bot, pendências;
- registros recentes e despesas resumidas;
- viagem atual/recente (origem, destino, material, quantidade);
- última atualização operacional em texto;
- totais locais do dia.

## 4. Intents e actions

Intents: `record_event`, `complete_record`, `admin_question`, `sheet_summary_request`, `sheet_change_request`, `broadcast_request`, `ask_driver_followup`, `driver_status_update`, `trip_status_question`, `bot_identity_question`, `operational_summary_request`, `unknown`.

Actions: `none`, `reply`, `store_status_update`, `request_confirmation`, `block_sheets`, `block_broadcast`.

JSON típico: `intent`, `action`, `confidence`, `reply`, `fields`, `target`, `requiresConfirmation`.

- Resposta informativa segura → `reply`.
- Atualização livre do motorista → `store_status_update` (texto associado à conversa/viagem; sem mapa/GPS).
- Sheets real → `block_sheets` + confirmação; **não escreve**.
- Broadcast → `block_broadcast` + confirmação; **não envia em massa**.

## 5. Status operacional

Frases como `estou na BR 101`, `cheguei em Cratos`, `estou descarregando`, `parei no posto`, `atrasou por chuva` viram `driver_status_update`. O store guarda o texto + timestamp + motorista/viagem. Admin pergunta `onde estamos?` e a reply usa viagem + última atualização.

## 6. Flags (LLM real continua off)

```
LLM_NLU_ENABLED=false
LLM_NLU_PROVIDER=fake
LLM_NLU_API_KEY=
LLM_NLU_BASE_URL=
```

Só `ENABLED=true` **e** `PROVIDER=llm` **e** key+base URL chamam `fetch` `/chat/completions`. Fake nunca dispara HTTP.

O interpretador **local** (fake) roda no engine por padrão para montar reply/action a partir do contexto. `LLM_NLU_ENABLED` não precisa estar `true` para isso — essa flag só libera o provider remoto.

## 7. Próximos passos do provider real

1. Validar o roteiro com fake no grupo exclusivo.
2. Preencher modelo, base URL e key **fora do git**.
3. Ligar as três condições acima.
4. Conferir logs: `nlu_followup` só então; sem Sheets; sem broadcast.
5. JSON inválido continua `unknown`.
