# 07 — Planilha Google

**Status (2026-10-09, VPS):** `SHEETS_TAB_MODE=vehicle_month` grava o **controle de viagens** em `Viagens-TFA7A94-2026-09` (não mexe na aba de teste `registros`) e um `Resumo-…` com COUNTA/SUM/QUERY: quantas viagens, toneladas, para onde foi, o que carregou, RECEBI. Linha RECEBI = verde. Pedágio/balança ficam de fora desta aba. Apps Script no repo é reserva.

**Agora não:** pastas Drive por caminhão nem um arquivo por mês. A aba já é o recorte mês+veículo na mesma planilha.

**Corte de sessão:** `ASSISTANT_V2_SESSION_STARTED_AT` no servidor limita o que entra na aba (não é o histórico inteiro do store).

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

## Abas derivadas (na mesma planilha, sem Drive)

O rewrite **só limpa/reescreve** `registros`. Outras abas no mesmo arquivo **não** são apagadas. Criar uma vez no Google (aba nova, célula A1):

| Aba | Fórmula (locale PT-BR: `QUERY` / `;`) |
|---|---|
| `abastecimentos` | `=QUERY(registros!A:W;"select * where C = 'abastecimento'";1)` |
| `despesas` | `=QUERY(registros!A:W;"select * where C = 'despesa'";1)` |
| `viagens` | `=QUERY(registros!A:W;"select * where C = 'viagem'";1)` |
| `pendencias` | `=QUERY(registros!A:W;"select * where F = 'incompleto'";1)` |

Coluna **C** = `tipo`, **E** = `veiculo` (depois filtra TFA), **B** = `data_registro` (depois corta mês). Quando existir pasta por caminhão/mês, o mapeamento já sai dessas colunas — não precisa inventar outro contrato.
