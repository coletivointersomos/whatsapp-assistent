# 06 — Planilha preview/export (sem Google)

**Status:** mapeamento local `OperationalRecord` → linha de planilha. **Não** conecta Google Sheets, Drive nem Workspace nesta etapa.  
**Comando:** `npm run sheets:preview` (TSV no terminal). `--demo` força o estado previsível; sem `--demo`, lê `data/store.json` se existir (somente leitura).

`records:preview` continua sendo diagnóstico de registros. Esta camada é a visão tabular para o experimento de quinta-feira.

## 1. O que esta etapa entrega

- Mapper puro em `src/sheets/mapper.ts` (sem SDK Google).
- Export TSV em `src/sheets/export.ts` — peça substituível por um adaptador Sheets depois.
- Uma linha por registro operacional, inclusive `incompleto`.
- Várias mensagens de origem (`sourceMessageIds`) = **uma** linha.
- Campos ausentes vazios; nada inventado.
- Demo local sem credenciais.

Colunas:

`data_registro`, `tipo`, `motorista`, `veiculo`, `status`, `origem_whatsapp`, `criado_em`, `atualizado_em`, `observacoes`, `litros`, `valor`, `posto_local`, `pagamento`, `valor_despesa`, `descricao_despesa`, `pagamento_despesa`, `origem`, `destino`, `material`, `quantidade`, `unidade`.

Abastecimento preenche litros/valor/posto/pagamento. Despesa preenche `valor_despesa` / `descricao_despesa` / `pagamento_despesa`. Viagem preenche origem/destino/material/quantidade/unidade. `criado_em` / `atualizado_em` vêm da mensagem-fonte mais antiga e da mais recente; sem fonte, ficam vazios. `origem_whatsapp` junta ids de mensagem (JID, se aparecer, é mascarado).

## 2. O que ainda não faz

- Não chama Google API.
- Não cria planilha, pasta Drive nem credenciais.
- Não escreve no store.
- Não envia WhatsApp.
- Não sincroniza com o volume da VPS.

## 3. Migração futura (produção Bruno / Coletivo)

O preview local permanece o contrato de colunas. O `export.ts` (TSV) é o ponto de troca:

1. **Projeto/app Google Workspace do Coletivo** — identidade do robô, não conta pessoal da Alana.
2. **Pasta Drive da transportadora** — arquivos da operação ficam nessa pasta, controlada pelo robô.
3. **Robô com permissão restrita** só nessa pasta (criar/atualizar as planilhas do fluxo).
4. **Alana e o dono** acessam/visualizam os arquivos; não precisam da chave da API.
5. **Google Sheets API** entra como adaptador real: mesma `SheetRow[]` que o mapper já produz, no lugar do TSV.

Até essa autorização, o experimento usa só `npm run sheets:preview`.
