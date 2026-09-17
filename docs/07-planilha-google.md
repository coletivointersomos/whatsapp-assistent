# 07 — Planilha Google (fundação dry-run)

**Status:** plano de sync local, fake sink, **sem** Google API, **sem** `googleapis`, **sem** credenciais.  
**Comandos:** `npm run sheets:preview` (TSV) · `npm run sheets:sync` (dry-run do que seria enviado).

## 1. Agora

- Mapper em `src/sheets/mapper.ts` inclui `record_id` (primeira coluna) = `OperationalRecord.id`.
- Sem `record_id`, o registro é `skip` e **não** entra em sync real.
- `SheetSink` descreve o destino: a aba existente é a fonte dos ids já enviados.
- `planSheetSync` calcula `insert` / `update` / `noop` / `skip`. Incompleto que vira completo no **mesmo** id vira `update`, não segundo `insert`.
- `MemorySheetSink` simula a aba nos testes. CLI assume aba vazia (adapter remoto ainda não existe) e **não escreve**.
- `--apply` **falha de propósito**: adapter Google não implementado. `SHEETS_SYNC_ENABLED=false` no `.env.example`; mesmo `true` não grava nesta etapa.

## 2. Próxima etapa (ainda não esta)

Adaptador Google Sheets API atrás de `SheetSink`: ler coluna `record_id`, upsert. Variáveis já nomeadas (valores vazios): `GOOGLE_APPLICATION_CREDENTIALS`, `DRIVE_FOLDER_ID`, `SHEETS_SPREADSHEET_ID`, `SHEETS_TAB_NAME`. JSON da service account permanece gitignorado (`secrets/`, `**/service-account*.json`).

## 3. Produção (Bruno / Coletivo)

1. App/projeto Google Workspace do Coletivo (identidade do robô).
2. Pasta Drive da transportadora; robô só nessa pasta.
3. Alana e o dono acessam os arquivos; não precisam da chave.
4. Planilha criada/atualizada pelo robô na pasta. Experimento pode usar `SHEETS_SPREADSHEET_ID` manual até a pasta existir.

## 4. Chave de dedupe

`record_id` estável. Várias mensagens WhatsApp → uma linha. Reenvio do mesmo registro → update/noop.

`sheets:preview` = ver linhas. `sheets:sync` = ver o plano de envio, sem Google.
