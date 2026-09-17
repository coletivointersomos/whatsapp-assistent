# 07 — Planilha Google

**Status:** código de rewrite pronto; **gravação off** até existirem ID + JSON no servidor.  
**Ainda não:** app Workspace / pasta Drive de produção.

## Experimento (quinta)

O robô **não** faz upsert linha a linha na API. Depois de persistir o `store`, se a escrita estiver configurada, ele:

1. garante a aba (`SHEETS_TAB_NAME`, padrão `registros`);
2. limpa a aba;
3. escreve header + linhas da sessão.

`record_id` = `OperationalRecord.id`. Incompleto que fecha reaparece na mesma linha no próximo rewrite.

### Checklist (você, fora do git)

1. Criar service account, ligar Google Sheets API.
2. Criar a planilha; copiar o ID da URL.
3. Compartilhar a planilha com o e-mail da service account (**editor**).
4. JSON gitignorado no servidor (`GOOGLE_APPLICATION_CREDENTIALS`). Nunca commit.
5. No `.env` do **transportadora** (não no lab/OpenWA):

```
SHEETS_SYNC_ENABLED=true
SHEETS_SPREADSHEET_ID=...
GOOGLE_APPLICATION_CREDENTIALS=/caminho/gitignorado.json
SHEETS_TAB_NAME=registros
```

6. Conferir local: `npm run sheets:sync` deve mostrar `rewrite da aba` e, sem credencial, `Escrita: bloqueada`. Com os três itens acima, `--apply` grava.
7. Log no webhook: `sheets_sync_ok` / `sheets_sync_skipped` / `sheets_sync_failed`. `SHEETS_SYNC_ENABLED=true` sem arquivo → `credentials_file_missing` a cada persist, sem inventar sucesso.

`ASSISTANT_V2_SESSION_STARTED_AT` corta o que entra na aba. Sem essa data, entram todos os registros elegíveis do store.

## Produção (depois)

App Workspace do Coletivo + pasta Drive da transportadora. Alana vê os arquivos; o robô trabalha a pasta.
