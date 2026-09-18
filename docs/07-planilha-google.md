# 07 — Planilha Google

**Status:** rewrite via **Apps Script** (quinta) ou service account (reserva). Gravação off até URL+token no servidor.  
**Ainda não:** app Workspace / pasta Drive de produção.

## Experimento (quinta) — Apps Script

O robô, depois de persistir o `store`, faz POST na URL do script. O script **reescreve** a aba `registros` (header + linhas da sessão). `record_id` = id do registro. Sem GCP, sem JSON de service account.

### No Google

1. Criar a planilha (pode ficar na pasta da transportadora).
2. Extensões → Apps Script. Apagar o stub. Colar `apps-script/registros-sync.gs`.
3. Em `SYNC_TOKEN`, o **mesmo** valor que vai em `SHEETS_APPS_SCRIPT_TOKEN` (não commitar).
4. Implantar → Nova implantação → **Aplicativo da Web** → executar como você → acesso **Qualquer pessoa**.
5. Copiar a URL que termina em `/exec`.

### No `.env` do transportadora

```
SHEETS_SYNC_ENABLED=true
SHEETS_APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
SHEETS_APPS_SCRIPT_TOKEN=o-mesmo-do-script
SHEETS_TAB_NAME=registros
```

Log: `sheets_sync_ok` / `sheets_sync_skipped` / `sheets_sync_failed`.  
`npm run sheets:sync` = dry-run. `--apply` dispara o POST se URL+token existirem.

`ASSISTANT_V2_SESSION_STARTED_AT` corta o que entra na aba.

## Reserva (service account)

Continua no código. Só entra se **não** houver `SHEETS_APPS_SCRIPT_URL`.

## Produção (depois)

App Workspace do Coletivo + pasta Drive. O Apps Script é o atalho da quinta, não a identidade final do robô.
