# Especificação técnica — Transportadora AI — Fase 1

## 1. Objetivo

Construir um sistema operacional para registrar despesas da frota a partir de áudios e fotos enviados pelos motoristas no WhatsApp. A inteligência artificial deve apenas preparar um rascunho; o registro final depende da confirmação humana da administradora.

O resultado da Fase 1 é um piloto funcional com dois motoristas e três categorias de despesa: **frete, combustível e manutenção**. Ao final do piloto validado, o fluxo deve poder ser expandido para os seis motoristas.

### Regra central de produto

> A IA organiza. A administração confirma. O sistema registra.

Nenhum lançamento deve ser gravado como aprovado sem uma ação explícita de confirmação por uma pessoa autorizada.

## 2. Problema a resolver

Hoje, informações de despesa chegam em áudios e fotos pelo WhatsApp e exigem transcrição e digitação manual. Isso gera quatro problemas principais:

- despesas sem vínculo claro com caminhão, motorista e frete;
- comprovantes dispersos em conversas;
- status de pagamento e conciliação incompletos;
- baixa visibilidade sobre o que está pendente ou já foi confirmado.

O sistema deve transformar cada mensagem relevante em um lançamento rastreável, sem obrigar o motorista a aprender um novo aplicativo.

## 3. Escopo da Fase 1

### Incluído

- cadastro de motoristas e caminhões do piloto;
- recebimento de mensagens de WhatsApp com áudio, imagem e texto;
- armazenamento do arquivo original e do comprovante no Google Drive;
- transcrição de áudio e extração assistida por IA dos dados da despesa;
- criação de um rascunho de lançamento;
- tela interna de revisão para aprovar, corrigir ou recusar o rascunho;
- persistência de dados no banco do sistema;
- sincronização de lançamentos aprovados para uma planilha do Google Sheets;
- trilha de auditoria de quem criou, alterou, confirmou ou recusou cada lançamento;
- visão simples de pendências e lançamentos recentes para a administração.

### Fora do escopo inicial

- mapa em tempo real;
- rastreamento GPS e telemetria;
- gestão de entregas;
- manutenção preventiva automatizada;
- sugestões proativas de rota, coleta ou atraso;
- dashboard completo do conceito visual existente;
- conciliação bancária automática;
- pagamentos dentro do sistema;
- multiempresa e cobrança.

Esses itens pertencem a evoluções posteriores, depois que a rotina de dados estiver comprovada.

## 4. Perfis e permissões

| Perfil | Permissões |
|---|---|
| Administrador | Configura usuários, cadastros, integrações e consulta todos os dados. Pode aprovar, corrigir ou recusar. |
| Administração | Revisa rascunhos, aprova, corrige, recusa e consulta lançamentos. |
| Motorista | Envia mensagens pelo WhatsApp. Não acessa o painel nesta fase. |

Somente Administrador e Administração podem confirmar um lançamento.

## 5. Fluxo principal

1. O motorista envia áudio, foto de comprovante ou texto para o número oficial de WhatsApp.
2. O webhook recebe a mensagem e registra o evento bruto.
3. O arquivo recebido é salvo no Google Drive, em pasta organizada por data e motorista quando houver identificação.
4. Para áudios, o sistema gera transcrição.
5. A IA interpreta o conteúdo e cria um rascunho com os dados extraídos e um nível de confiança por campo.
6. O sistema associa o remetente ao motorista cadastrado. Caso não reconheça, cria pendência para a administração.
7. A administração abre a fila de pendências, revisa o rascunho e escolhe: **Confirmar**, **Corrigir e confirmar** ou **Recusar**.
8. Quando confirmado, o lançamento é persistido no banco e sincronizado com a planilha Google Sheets.
9. O sistema registra quem confirmou, data/hora e alterações feitas na revisão.

### Estados do lançamento

`RECEBIDO -> PROCESSANDO -> AGUARDANDO_REVISAO -> CONFIRMADO | RECUSADO | ERRO`

Um lançamento `CONFIRMADO` pode receber o status financeiro `PENDENTE`, `PAGO` ou `CANCELADO`. A alteração desse status também deve gerar auditoria.

## 6. Campos de um lançamento

| Campo | Obrigatório para confirmar | Observação |
|---|---:|---|
| Data da despesa | Sim | Pode ser corrigida pela administração. |
| Categoria | Sim | Frete, combustível ou manutenção no piloto. |
| Valor | Sim | Decimal em BRL, maior que zero. |
| Caminhão | Sim | Selecionado entre os cadastros ativos. |
| Motorista | Sim | Preenchido pelo número de WhatsApp ou selecionado manualmente. |
| Fornecedor | Não | Obrigatório quando disponível no áudio ou comprovante. |
| Frete relacionado | Não | Obrigatório para categoria frete; opcional nas demais. |
| Status financeiro | Sim | Inicia como PENDENTE. |
| Comprovante | Não | Link para o arquivo original no Drive. |
| Transcrição | Não | Mantida para auditoria e revisão. |
| Origem | Sim | WhatsApp, entrada manual ou importação. |
| Confirmado por | Sim | Usuário interno que aprovou. |
| Observações | Não | Campo livre. |

## 7. Modelo de dados mínimo

### Entidades

- `users`: usuários internos, perfil e status.
- `drivers`: nome, telefone WhatsApp normalizado, ativo/inativo.
- `vehicles`: placa, apelido, tipo e ativo/inativo.
- `freights`: identificador, cliente, origem, destino, data e status. Inicialmente pode ser opcional ou simplificado.
- `expenses`: registro financeiro principal e todos os campos do item 6.
- `attachments`: arquivos originais, tipo, URL/ID do Drive e relação com despesa.
- `inbound_messages`: evento recebido do WhatsApp, remetente, conteúdo bruto, horário e estado de processamento.
- `ai_extractions`: resposta estruturada da IA, confiança por campo e versão do prompt/modelo.
- `audit_logs`: entidade, ação, usuário, antes/depois e horário.
- `integrations`: referências seguras para planilha, pasta do Drive e configurações de sincronização.

### Regras de integridade

- `expenses.confirmed_by` e `expenses.confirmed_at` devem existir quando o estado for `CONFIRMADO`.
- uma mensagem recebida pode originar vários anexos, mas apenas um rascunho inicial por evento;
- o ID do evento do WhatsApp deve ser único para impedir duplicidade em reentregas de webhook;
- o registro no Sheets deve manter o ID interno da despesa para sincronização idempotente;
- valores monetários devem ser armazenados como decimal, nunca como ponto flutuante.

## 8. Integrações

### WhatsApp Business Platform

- Configurar um número exclusivo para o piloto.
- Receber webhooks de mensagens e anexos.
- Validar assinatura do webhook.
- Normalizar telefone do remetente para associação com motorista.
- Responder apenas com mensagens operacionais simples quando necessário, sem simular confirmação que ainda depende da administração.

### IA

- Transcrever áudios em português do Brasil.
- Extrair dados em formato estruturado e validável.
- Retornar `null` para dados ausentes; nunca inventar valor, placa ou fornecedor.
- Informar confiança por campo e sinalizar ambiguidade.
- A aplicação, e não o modelo, deve aplicar regras de negócio e validar dados.

Formato esperado da extração:

```json
{
  "category": "fuel | freight | maintenance | null",
  "amount": 0,
  "expense_date": "YYYY-MM-DD | null",
  "vehicle_hint": "string | null",
  "driver_hint": "string | null",
  "supplier": "string | null",
  "freight_hint": "string | null",
  "summary": "string",
  "missing_fields": ["string"],
  "confidence": {
    "category": 0,
    "amount": 0,
    "expense_date": 0
  }
}
```

### Google Drive

- Criar uma pasta raiz da operação e subpastas por ano/mês.
- Salvar arquivo original sem alteração.
- Persistir ID e URL do arquivo no banco.
- Restringir acesso conforme a conta corporativa da operação.

### Google Sheets

- A planilha continua sendo uma visão operacional e fonte de consulta, mas o banco do sistema é a fonte transacional.
- Sincronizar apenas despesas confirmadas.
- Uma linha por despesa, com ID interno, dados principais, status financeiro, URL do comprovante e responsável pela confirmação.
- A sincronização deve suportar repetição sem criar linhas duplicadas.

## 9. Interfaces da Fase 1

### 9.1 Login

- autenticação para usuários internos;
- redirecionamento para a fila de revisão após login.

### 9.2 Fila de revisão

- lista de pendências em ordem de recebimento;
- filtros por motorista, caminhão, categoria, estado e período;
- destaque para campos ausentes ou baixa confiança;
- contador de itens aguardando revisão.

### 9.3 Tela de revisão de lançamento

- áudio reproduzível, transcrição e anexos;
- formulário editável com todos os campos do lançamento;
- ação Confirmar;
- ação Corrigir e confirmar;
- ação Recusar com motivo obrigatório;
- histórico de alterações e responsáveis.

### 9.4 Visão operacional simples

- total de itens aguardando revisão;
- total confirmado no dia e no período;
- total pendente de pagamento;
- lista dos últimos lançamentos;
- sem mapa, telemetria ou análises avançadas nesta fase.

## 10. Arquitetura sugerida

Esta é uma sugestão para acelerar o início; pode ser adaptada.

- **Frontend e backend web:** Next.js com TypeScript.
- **Banco e autenticação:** PostgreSQL e autenticação gerenciada, por exemplo Supabase.
- **ORM e migrações:** Prisma ou equivalente com migrações versionadas.
- **Processamento assíncrono:** fila para download de mídia, transcrição, extração por IA e sincronização Google.
- **Armazenamento documental:** Google Drive, com IDs salvos no banco.
- **Observabilidade:** logs estruturados, rastreio de erros e auditoria de ações humanas.
- **Hospedagem:** ambiente com HTTPS público para webhooks e variáveis de ambiente protegidas.

O repositório deve conter `.env.example`, documentação de configuração, migrações, testes das regras de negócio e um arquivo de decisão arquitetural para cada escolha importante.

## 11. Requisitos não funcionais

- Interface em português do Brasil e valores em BRL.
- Proteção de dados pessoais e financeiros por controle de acesso.
- Segredos de WhatsApp, IA e Google somente em variáveis de ambiente; nunca no repositório.
- Validação de dados no servidor, mesmo que o formulário valide no navegador.
- Webhooks idempotentes e logs suficientes para reprocessar falhas.
- Backup e exportação dos lançamentos.
- Design responsivo, priorizando uso em desktop pela administração.
- Auditoria imutável para confirmação, correção, recusa e mudança de status financeiro.

## 12. Plano de implementação

### Marco 0 — Auditoria do projeto Lovable

1. Exportar ou conectar o projeto atual ao GitHub.
2. Identificar páginas existentes, dependências, autenticação e banco, se houver.
3. Preservar o dashboard atual como referência visual, sem implementá-lo integralmente agora.
4. Decidir se a base atual será aproveitada ou apenas usada como protótipo visual.

### Marco 1 — Fundação

1. Criar repositório, padrões de código e ambientes local/homologação/produção.
2. Criar banco, autenticação, perfis e entidades de cadastro.
3. Implementar telas de motoristas, caminhões e usuários.
4. Criar migrações e dados de demonstração não produtivos.

### Marco 2 — Entrada e processamento

1. Configurar WhatsApp e webhook.
2. Persistir mensagens recebidas e baixar anexos.
3. Integrar transcrição e extração estruturada por IA.
4. Criar rascunho de lançamento e estados de processamento.

### Marco 3 — Revisão e registro

1. Construir fila de revisão e tela de detalhe.
2. Implementar validações, confirmação, correção e recusa.
3. Gravar auditoria.
4. Integrar Google Drive e Google Sheets.

### Marco 4 — Piloto e expansão

1. Cadastrar dois motoristas e seus caminhões.
2. Rodar o fluxo com mensagens reais assistidas pela administração.
3. Corrigir vocabulário, regras e pontos de erro observados.
4. Expandir para os demais motoristas somente após validação.

## 13. Critérios de aceite do piloto

O piloto está pronto quando todos os itens abaixo forem demonstrados:

- um motorista envia áudio e foto pelo WhatsApp;
- a mensagem aparece como pendência no painel;
- a IA cria um rascunho sem confirmar automaticamente;
- a administração corrige campos faltantes e confirma o lançamento;
- o comprovante fica acessível pelo lançamento;
- o registro confirmado aparece uma única vez na planilha;
- o sistema mostra quem confirmou e o histórico da alteração;
- uma mensagem reenviada pelo WhatsApp não cria despesa duplicada;
- uma falha de IA ou de integração gera item recuperável, sem perder a mensagem original.

## 14. Próximas decisões necessárias antes do desenvolvimento

Ver também `docs/piloto/pendencias.md`.

1. Definir o número oficial de WhatsApp Business e a conta responsável.
2. Confirmar os dois motoristas e os caminhões do piloto.
3. Confirmar a conta Google que hospedará Drive e Sheets.
4. Consolidar categorias e subcategorias iniciais.
5. Definir se fretes serão cadastrados no sistema desde o início ou vinculados manualmente pela administração.
6. Validar com Alana a tela e a rotina de confirmação diária.

## 15. Evolução pós-Fase 1

Quando o piloto estiver estável, o dashboard visual já existente pode se tornar a próxima camada. A prioridade recomendada é:

1. indicadores de pendências, gastos e status financeiro;
2. filtros por caminhão, motorista, categoria e frete;
3. relatórios e exportações;
4. alertas operacionais;
5. mapa, telemetria, entregas e recomendações proativas de IA.

O dashboard deve consumir os mesmos dados e regras da Fase 1, sem criar uma segunda fonte de verdade.
