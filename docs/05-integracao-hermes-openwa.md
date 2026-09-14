# 05 — Integração Hermes/OpenWA (teste real controlado)

**Status:** serviço próprio preparado no repo · **Não autoriza** alterar lab/bridge, compose down, merge em `main`, envio WhatsApp sem autorização explícita no momento do teste.  
**Cliente:** Transportadora Arnaldo. **Alana:** administradora do WhatsApp e da central.  
**Serviço:** `hermes-arnaldo-transportadora` (porta **8791**, distinta da 8790 do lab).

## 1. Decisão técnica

O produto continua no `whatsapp-assistent`. O lab/bridge só emprestam o **contrato** OpenWA.

Fluxo alvo:

```
OpenWA (VPS)
  → POST /webhook deste serviço
  → HMAC (obrigatório se HMAC_REQUIRED=true)
  → sessionId + allowlist
  → InboundMessage
  → engine
  → send gate
  → OpenWA send (somente se LIVE_SEND=true e grupo de teste)
```

`LIVE_SEND=false` é o padrão. Só a string exata `true` liga envio. Troca de número = `SESSION_ID` na config. Expansão para ~6 chats = `ALLOWED_JIDS` / `channel.conversations`. O engine não conhece o número.

## 2. Dry-run vs teste real vs piloto

| Modo | O que faz | Envio WhatsApp |
|---|---|---|
| Dry-run local | `npm run hermes:dry-run` com fixtures | Nunca |
| **Teste real controlado** (esta etapa) | Serviço HTTP próprio, um grupo de teste | Só com `LIVE_SEND=true` e JID = `TEST_GROUP_JID` na allowlist |
| Piloto (~6 chats) | Mesma arquitetura, allowlist maior | **Não agora** |
| Produção aberta | Fora de escopo | Não |

Processar um chat allowlisted que **não** é o grupo de teste **não** dispara envio.

## 3. Serviço na VPS (quando autorizado)

Nome: `hermes-arnaldo-transportadora`.

Arquivos de embalagem (exemplos, sem secrets):

- `Dockerfile`
- `docker-compose.example.yml`
- `.env.example` (`LIVE_SEND=false`)
- `npm run start` → `src/server.ts`
- `GET /health`, `POST /webhook`

Não reutilizar porta 8790 (lab) nem 9126 (Bruno). Não apontar o mesmo webhook de grupo para lab + bridge + este serviço.

Compose de exemplo **não** junta automaticamente a rede do `openwa-api`. Isso só no teste autorizado, sem mexer nos containers já existentes.

Persistência: JSON em `STORE_PATH` (volume `/data` no compose de exemplo).

## 4. Como habilitar / desabilitar envio real

Desligado (padrão):

```
LIVE_SEND=false
```

Ligado (somente no teste autorizado):

```
LIVE_SEND=true
HMAC_REQUIRED=true
OPENWA_HMAC_SECRET=<segredo, fora do git>
SESSION_ID=<sessão OpenWA de teste>
TEST_GROUP_JID=<JID do grupo de teste>
ALLOWED_JIDS=<pelo menos o JID do grupo de teste>
OPENWA_BASE_URL=http://openwa-api:2785
```

O processo **recusa subir** se `LIVE_SEND=true` e faltar `TEST_GROUP_JID` na allowlist, `OPENWA_BASE_URL` ou HMAC quando exigido.

Desligar: `LIVE_SEND=false` e reiniciar **este** serviço (não o lab). Log de arranque deixa explícito se o envio está ligado ou desligado.

## 5. Allowlist

Fonte: `CHANNEL_FILE` e/ou `ALLOWED_JIDS`, `ADMIN_IDS`, `BOT_IDS`, `DRIVER_JIDS`. Placeholders em `config/channel.example.json`. Config viva (`config/channel.json`, `.env`) **não** vai no git.

Trava em três camadas:

1. Adaptador recusa `chatId` fora da lista (`unauthorized_conversation`).
2. Engine só opera conversas do estado (preenchidas pela config).
3. Send gate só envia se o JID for **exatamente** `TEST_GROUP_JID`.

HMAC (lab): headers `x-openwa-signature` ou `x-hub-signature-256`, HMAC-SHA256 hex do body bruto (`sha256=` aceito). Segredo não está neste repo. Sem segredo + `HMAC_REQUIRED=true` → não sobe.

## 5.1 Retomada controlada (`POST /resume`)

Sem scheduler. Depois que a pausa da Alana expira, um operador pode pedir **uma** pergunta de pendência para o `TEST_GROUP_JID`.

```
POST /resume
x-resume-secret: <OPENWA_HMAC_SECRET>
Content-Type: application/json

{}
```

Ou o mesmo HMAC do webhook no body. Body opcional: `{ "conversationId": "<TEST_GROUP_JID>" }` — outro JID é recusado.

Envia só se `LIVE_SEND=true`, allowlist, pausa expirada, registro incompleto ainda não perguntado nesta retomada (dedupe por conversa + `recordId` + campos faltantes + `resume_pending_question`). Sem loop automático.

## 6. Envio OpenWA

Contrato reaproveitado do lab/bridge:

`POST {OPENWA_BASE_URL}/api/sessions/{sessionId}/messages/text`  
JSON `{ "chatId", "text" }`  
Header de token: `X-Api-Key` (ajustável por `OPENWA_API_KEY_HEADER`).

Se o path real do `openwa-api` divergir, ajuste `OPENWA_SEND_PATH` **sem** mudar o engine. Confirmar o path no `bridge/providers.py` no momento do teste autorizado.

## 7. Checklist do teste real (pedir autorização antes)

1. Lab e `hermes-wa-bridge` **não** escutam o mesmo grupo.
2. `.env` na VPS com `LIVE_SEND=false` primeiro; health ok.
3. Webhook OpenWA aponta **só** para este serviço.
4. HMAC válido com payload de teste (sem mensagem de produto).
5. Autorização explícita descrevendo: serviço, JID do grupo, texto esperado, como desligar.
6. Só então `LIVE_SEND=true`.
7. Uma mensagem incompleta no grupo (o engine pergunta o que falta) — esse é o envio observável.
8. Desligar `LIVE_SEND=false` ao terminar.

**Não executar os passos 5–8 sem autorização nesta conversa.**

## 8. Troca futura de número / ~6 chats

- Número novo: nova sessão OpenWA + `SESSION_ID` (+ `adminIds`/`botIds` se os JIDs da Alana mudarem).
- ~6 chats: ampliar `ALLOWED_JIDS` / `conversations`. Envio geral para esses chats **não** está ligado nesta etapa; o gate de teste continua preso a `TEST_GROUP_JID` até o piloto ser autorizado.
- Core: continua só `InboundMessage`.

## 9. Dry-run local

```bash
npm run hermes:dry-run
npm run start   # exige config; para smoke local: HMAC_REQUIRED=false LIVE_SEND=false
```

## 10. O que falta para o grupo real

- Autorização para criar o container **novo** (sem tocar lab/bridge).
- JIDs reais só em `.env` / `channel.json` fora do git.
- Confirmar path/header de send no `openwa-api` em uso.
- Registrar webhook exclusivo.
- STT se áudio chegar sem `body`.
- Não conectar Google Sheets nesta etapa.

## 11. Riscos

- Lab já esteve com `BRIDGE_MODE=live` vs compose “observe”.
- Dois consumers no mesmo grupo = duas respostas.
- Path OpenWA pode precisar de ajuste fino (`OPENWA_SEND_PATH`).
- Falha de send após persistir o inbound **não** reenvia na duplicata (log `send_failed`).
- Secrets em log/commit.

## 12. Inventário (resumo)

`hermes-arnaldo-lab`: `/opt/hermes-arnaldo-lab`, porta interna 8790.  
`hermes-wa-bridge`: irmão; não compartilhar webhook.  
Entrada: `{ event, sessionId, data }` com `chatId` / `author` / `from`.  
Esta etapa **não** alterou a VPS.
