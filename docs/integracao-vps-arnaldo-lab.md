# Integração VPS — `hermes-arnaldo-lab` e Alana Transportes

**Status:** leitura na VPS em 2026-09-11 · **Não autoriza** deploy, webhook, cópia de código nem merge  
**Fontes:** `/opt/hermes-arnaldo-lab` (release `0.5.1-lunch-safe`), `docker inspect hermes-arnaldo-lab`, repo local `whatsapp-assistent`  
**Secrets:** não copiados. JIDs de WhatsApp do `config.json` omitidos deste arquivo.

Comparar com: `docs/01-produto.md`, `docs/02-funcionamento.md`, `docs/04-especificacao-tecnica-mvp.md`.

## 1. O que é o `hermes-arnaldo-lab`

É um **laboratório isolado da Transportadora Arnaldo**, não um segmento Hermes dashboard (9119–9126). O nome “Hermes” aqui significa **bridge multimodal** (Python/FastAPI), molde copiado de `servidor/hermes-wa-bridge`.

Persona em execução (`deploy/instance-observe/persona.md`):

> Assistente virtual da **Transportadora Arnaldo** em **observação silenciosa**. Interpreta em PT-BR. **Esta etapa não envia respostas ao WhatsApp.**

Escopo do MVP do lab (README): **lembretes internos de agenda** (`/agenda`, `/confirmar`), mídia (áudio/imagem), memória por instância. Explicitamente **não** é TMS, ERP, faturamento, rastreamento nem confirmação comercial de coleta/entrega.

Não há menção a **Alana** nos arquivos lidos. O vínculo com este produto é o domínio de **transportadora** (Arnaldo = protótipo; Alana = produto InterSomus neste repo).

## 2. Onde está e que stack usa

| Item | Valor |
|---|---|
| Pasta VPS | `/opt/hermes-arnaldo-lab/` |
| Release em uso | `releases/0.5.1-lunch-safe/` (há também `0.5.0-edcadb1958c5` e `7fee32612618`) |
| Container | `hermes-arnaldo-lab` · **Up**, healthy |
| Imagem | `hermes-arnaldo-lab:0.5.1-lunch-safe` |
| Porta do app | **8790** só **dentro** da rede Docker (health em `127.0.0.1:8790/health`) |
| Volume | `hermes-arnaldo-lab-data` → `/data` (SQLite) |
| Instância montada | `deploy/instance-observe` → `/instance` (somente leitura) |
| Rede | `docker_default` |
| Código | Python 3 · FastAPI (`app.py`) · pacote `bridge/` |
| Persistência lab | SQLite (`bridge.sqlite3`) |
| LLM | 9Router (`BRIDGE_CHAT_BACKEND=9router`) |
| STT | faster-whisper local (`BRIDGE_STT_BACKEND=local`) |
| TTS | Edge (`BRIDGE_TTS_BACKEND=edge`) |
| Visão | `disabled` |

Origem no Mac, segundo o README: `Projetos - new/vps/servidor/hermes-wa-bridge`.

### Arquivos/pastas relevantes (reaproveitamento futuro)

| Caminho no release | Papel |
|---|---|
| `bridge/` | Núcleo: permissão, agenda, mídia, OpenWA, auditoria |
| `app.py` | `POST /webhook` HMAC + `GET /health` |
| `instances/template/` | Molde sem cliente |
| `instances/arnaldo/` | Persona/memória/config da transportadora lab |
| `deploy/instance-observe/` | Persona **silenciosa** atualmente montada |
| `deploy/compose.vps-observe.yml` | Compose documentado de observação |
| `tests/` | Agenda, ingress, mídia, resiliência, duplicidade |
| `docs/MIGRATION.md`, `VPS-STAGING.md` | Como (não) ir a live |

Não reaproveitar: `secrets/`, volume SQLite, `config.json` com IDs reais, `compose.vps-live-bruno.yml` (outro contexto).

## 3. Relação com WhatsApp / Hermes

**Não** é o container `hermes-dashboard` nem o `hermes-segment-assistente-bruno`.

Fluxo de mensagens:

1. **OpenWA** (`openwa-api`, `127.0.0.1:2785` no host, `http://openwa-api:2785` no lab).
2. Webhook HMAC (`x-openwa-signature` / `x-hub-signature-256`) em `/webhook`.
3. Allowlist: `session_id` + `allowed_chats` + `operators` + `bot_ids` no `config.json`. Em grupo, **exige menção**.
4. `Runtime.ingest` → SQLite (dedupe, fila).
5. Envio: classe `OpenWA` em `bridge/providers.py` (`POST .../api/sessions/{session}/messages/...`).

O container **`hermes-wa-bridge`** (também 8790 interno) é **outra** ponte, irmã. O lab foi desenhado para **não** substituir o webhook dela. Docs alertam: se os dois ouvirem o mesmo grupo, **os dois respondem**.

O agente Hermes central (Telegram/dashboard) **não** processa essas mensagens. O modelo 9Router só propõe ações de um **conjunto fechado**; o bridge confirma depois do commit SQLite.

### Como envia (e o que o container está fazendo agora)

Documentação `compose.vps-observe.yml`: `BRIDGE_MODE=dry-run`, `BRIDGE_ALLOW_LIVE=false`, chave OpenWA vazia, “never sends”.

**Inspect do container em execução (2026-09-11):** `BRIDGE_MODE=live`, `BRIDGE_ALLOW_LIVE=true`, `BRIDGE_ENABLE_PROVIDER=true`, `BRIDGE_OPENWA_BASE=http://openwa-api:2785`. Persona montada ainda diz que **não envia**. Há tensão entre compose versionado, persona “observe” e env live. **Não foi alterado nada nesta inspeção.** Tratar como risco: não assumir dry-run só porque a persona fala em silêncio.

## 4. Indícios de uso para a transportadora

| Tema | No lab Arnaldo |
|---|---|
| Alana | **Não** aparece |
| Transportadora | **Sim** — “Transportadora Arnaldo” |
| Motorista / caminhão | Só na negativa: *não inventar* motoristas/frota |
| Abastecimento / despesa / viagem como registro | **Não** modelados |
| Frete | Memória: “tabela de fretes ainda não cadastrada” |
| Coleta | Lembretes `/agenda` de “conferir documentação da coleta”, não lançamento operacional |
| Áudio / foto | Sim: STT, visão (off), PTT; imagem **não** dispara ação |
| Allowlist de conversas | Sim (grupo de teste + operadores) |
| Extra: `lunch_log` | Log de almoço no `config.json` observe — **lab**, não Fase 1 Alana |

Conclusão: o lab prova **canal WhatsApp (OpenWA) + isolamento + mídia + não inventar dados**. Não implementa o produto Alana (coleta diária, três tipos de registro, pausa 15 min da administradora, central de comando).

## 5. Comparação com `whatsapp-assistent`

| | Lab Arnaldo (VPS) | Repo atual (Fase 1) |
|---|---|---|
| Canal | OpenWA webhook real (lab) | Simulador + envelope `InboundMessage` |
| Domínio | Agenda/lembretes + mídia | Abastecimento, despesa, viagem/frete |
| Regras Alana | Ausentes | Pausa 15 min (`sentAt`), suspensão, central, `assinada` ≠ pago |
| Extração | LLM 9Router (ações fechadas) + comandos `/agenda` | Parser determinístico, motorista em linguagem natural |
| Persistência | SQLite no volume Docker | JSON local (`data/` gitignored) |
| Preview Sheets/agenda do dia | Não | `npm run sheets:preview` / `schedule:preview` |
| Testes de produto Alana | Não | 25 testes do núcleo |
| Isolamento de chat | Allowlist OpenWA | Lista seed (João/Ana/central) |
| Envio WhatsApp | Código OpenWA + modos dry-run/live | Sem envio |

**Já existe melhor no repo novo:** modelo de registros da folha, regras da Alana, piloto 2 motoristas, previews, testes de negócio.

**Já existe melhor no lab:** contrato OpenWA (HMAC, JID exato, mídia inline, estados de outbox, não reenviar se incerto), STT local, fila, auditoria.

## 6. Recomendação

**Evoluir o repo `whatsapp-assistent` e só puxar o lab como adaptador de transporte**, numa etapa autorizada.

Não transformar o lab no produto final: o domínio é agenda; a identidade é Arnaldo; o `config.json` e o volume são de um grupo de teste; o env live mistura lab com produção de WhatsApp; copiar o banco ou o compose live para a Alana viola o próprio README do lab.

Não copiar: secrets, JIDs, SQLite, `lunch_log`, persona Arnaldo como se fosse Alana, `compose.vps-live-bruno.yml`.

Reaproveitar depois (código **lido** no Mac `hermes-wa-bridge` / release, não copiar da VPS agora): `app.py` webhook, `bridge/config.py` (allowlist), `bridge/providers.py` (OpenWA), testes de dedupe; montar um `src/adapters/` que preencha `InboundMessage`.

## 7. Próximo passo seguro

1. Manter a Fase 1 no GitHub (`feat/fase-1-fundacao-assistente`) como fonte do produto Alana.  
2. No repo `vps/` (Mac), abrir `servidor/hermes-wa-bridge` e o molde `instances/template/` — **sem** ligar o WhatsApp da Alana.  
3. Desenhar um **segmento novo** (container, volume, secrets, porta ≠ 9126, ≠ 8790 do lab se houver colisão de nomes).  
4. Só então: allowlist dos 2 motoristas + central; webhook **exclusivo** (não compartilhar com `hermes-wa-bridge` nem com o grupo Arnaldo).  
5. Não registrar webhook novo, não `compose down`, não alterar Caddy/registry até autorização explícita.

O `registry.yaml` do Hermes **não** lista este lab (está correto: não é segmento Telegram). Não atualizar o registry nesta etapa.
