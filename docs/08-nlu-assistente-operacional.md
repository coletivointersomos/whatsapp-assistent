# 08 — Assistente operacional (NLU controlada)

**Status:** camada NLU no repo Alana. **Hermes/OpenWA continua só canal.** LLM não executa ação, não escreve Sheets e não manda broadcast.  
**Padrão:** parser determinístico primeiro → JSON NLU opcional → engine valida → resposta/ação.

## 1. Hermes canal vs inteligência

O container da transportadora recebe e envia WhatsApp (allowlist + send gate). A inteligência de registro (abastecimento/despesa/viagem, complemento, pausa) está neste código TypeScript. Outros Hermes da VPS têm LLM; **não** copiamos persona, secrets, SQLite nem tools deles.

## 2. Por que LLM entra

O parser cobre frases típicas. Admin e falas curtas (“são joão”, perguntas de total) precisam de um interpretador. O LLM, quando ligado, **só classifica intenção em JSON**.

## 3. Arquitetura

```
mensagem
  → regras determinísticas (extract / complemento / pausa / permissão)
  → se ainda precisar: NLU (fake | llm via fetch)
  → JSON validado (intent, confidence, fields…)
  → engine decide: perguntar, fechar registro, recusar ação sensível
  → send gate (LIVE_SEND + TEST_GROUP_JID)
```

Sheets: `sheets:preview` / `sheets:sync` dry-run. Totais admin usam o store local.

## 4. O que o LLM pode e não pode

**Pode:** sugerir `record_event`, `complete_record`, `admin_question`, resumo local, marcar pedido de planilha/broadcast/follow-up.  
**Não pode:** escrever Google Sheets, enviar em massa, decidir allowlist, inventar valores, ignorar pausa da Alana para o motorista, logar API key.

Ação sensível: se não for admin → bloqueada; se for admin → `requiresConfirmation`, sem executar.

## 5. Flags

```
LLM_NLU_ENABLED=false
LLM_NLU_PROVIDER=fake
LLM_NLU_MODEL=
LLM_NLU_API_KEY=
LLM_NLU_BASE_URL=
LLM_NLU_TIMEOUT_MS=8000
```

Só `LLM_NLU_ENABLED=true` **e** `LLM_NLU_PROVIDER=llm` **e** key+base URL chamam rede. Sem isso, fake não dispara HTTP. Complementos `sao joao` / `hoje` e respostas de admin locais **não dependem** do LLM.

## 6. Ativar no grupo controlado (depois)

1. Grupo exclusivo + allowlist de 1 chat.  
2. `LIVE_SEND` só com o send gate.  
3. Ligar NLU só com as três condições acima.  
4. Conferir dry-run de Sheets.  
5. Não ligar broadcast nem alteração real de planilha nesta fase.

## 7. Limites da demo

Totais = registros locais do store/demo. Sem Google. Broadcast e coluna nova são recusa explícita. Provider real usa `fetch` OpenAI-compatible, sem SDK. JSON inválido → `unknown`.
