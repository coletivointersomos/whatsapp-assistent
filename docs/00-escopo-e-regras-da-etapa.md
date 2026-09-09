# 00 — Escopo e regras da etapa

**Status:** documentação · **Não autoriza:** implementação

## 1. Limite desta etapa

Documentar um assistente de WhatsApp para a transportadora administrada por Alana. Sem código, banco, dependências, integrações, deploy, commit ou push.

| Permitido | Não permitido |
|---|---|
| Markdown em `docs/`; exemplos curtos de conversa | Código, scaffolding, configs, DB, migrações, deps |
| Referenciar material antigo sem apagá-lo | Sobrescrever docs existentes sem necessidade |
| Registrar pendências abertas | Assumir painel web, banco próprio ou número WhatsApp separado como decisão fechada |

## 2. Inventário breve

| Caminho | Tratamento |
|---|---|
| `README.md`, `docs/especificacao/fase-1.md` | Spec antiga (painel, banco, número Business) — referência histórica, não decisão |
| `docs/piloto/pendencias.md`, `docs/decisoes/`, `docs/setup/` | Mantidos; parcialmente desatualizados em relação a este escopo |

## 3. Fatos confirmados

| Fato |
|---|
| Hoje: registros em papel no mês, entrega à Alana no fim do período |
| Objetivo: coleta pelo WhatsApp ao longo do período (melhor completude, menos consolidação) |
| Assistente no WhatsApp da Alana; Hermes indicado (capacidades a verificar) |
| Piloto: 2 motoristas; expansão prevista: 6 |
| Acesso só a conversas autorizadas dos motoristas + central de comando |
| Assistente pode pedir informações; respeita pausas e intervenção da Alana |
| Piloto: coleta diária (pode ir para semanal); tipos: viagem, abastecimento, despesa |
| Pausa por mensagem da Alana: 15 min; suspensão da central: período determinado |

## 4. O que não está decidido

Painel web, banco próprio, número WhatsApp separado, Drive/Sheets, comprovantes digitais e demais itens — ver `docs/03-pendencias-e-validacao.md`. Detalhe da operação: `docs/02-funcionamento.md`.

## 5. Índice desta documentação

| # | Arquivo | Conteúdo |
|---|---|---|
| 0 | `docs/00-escopo-e-regras-da-etapa.md` | Este arquivo |
| 1 | `docs/01-produto.md` | Objetivo, rotina atual, rotina desejada, pessoas, piloto e expansão |
| 2 | `docs/02-funcionamento.md` | Coleta, faltantes, indisponibilidade, lembretes, Alana, pausa/retomada, central |
| 3 | `docs/03-pendencias-e-validacao.md` | Decisões abertas, Hermes a verificar, checklist do piloto |

Cada assunto vive em um arquivo; os outros apenas referenciam.
