# 01 — Produto

Ver também: `docs/00-escopo-e-regras-da-etapa.md` (limites) · `docs/02-funcionamento.md` (comportamento) · `docs/03-pendencias-e-validacao.md` (abertos)

## Objetivo

Substituir o acúmulo mensal de registros em papel pela coleta via WhatsApp ao longo do período, para melhorar a completude das informações e reduzir o trabalho de consolidação da Alana.

## Rotina atual

| Quem | O que faz |
|---|---|
| Motoristas | Anotam informações à mão, em papel, durante o mês |
| Motoristas | Entregam o material à Alana no fim do mês |
| Alana | Consolida e controla a operação a partir desse material |

A coleta regular por WhatsApp ainda não existe; será uma mudança de processo.

### Estrutura do papel (fotos das folhas atuais)

As fotos servem para identificar a estrutura da coleta — não para transcrever lançamentos históricos. Manuscritos e valores ambíguos nas fotos não são dados confirmados.

| Registro | Campos no papel |
|---|---|
| Identificação da folha | Mês, motorista e identificação do caminhão/placa, quando preenchidos |
| Abastecimento | Data, litros, valor total em reais, local e pagamento |
| Despesa | Data, valor em reais, descrição e pagamento |
| Viagem | Data, origem, destino, material transportado, quantidade e unidade da carga, observação |

Observações no papel também trazem cálculos de frete, valores recebidos e depósitos. Há cargas em unidades diferentes de toneladas (ex.: m³) — por isso quantidade + unidade, sem presumir toneladas.

## Rotina desejada

| Quem | O que muda |
|---|---|
| Motoristas (autorizados) | Respondem ao assistente no WhatsApp da Alana ao longo do período |
| Assistente | Coleta viagens, abastecimentos e outras despesas; pede só o que falta |
| Alana | Continua no controle; pode falar com motoristas, pausar o bot e orientar pela central de comando |

**Piloto:** coleta diária (pode passar a semanal conforme o teste). Frete não é tratado automaticamente como despesa. Detalhe do comportamento → `docs/02-funcionamento.md`. Comprovantes digitais e demais abertos → `docs/03-pendencias-e-validacao.md`.

## Pessoas

| Papel | Função |
|---|---|
| Alana | Administradora; dona do WhatsApp do assistente; decide pausas e comandos |
| Motorista (piloto) | Envia dados operacionais; não administra regras gerais |
| InterSomus / responsável do projeto | Indica Hermes como integração pretendida |

## Piloto e expansão

| Etapa | Escopo |
|---|---|
| Piloto | Dois motoristas autorizados + central de comando; coleta diária |
| Expansão | Seis motoristas, após validação do piloto |

Conversas fora da lista autorizada ficam fora do acesso operacional permitido.

## Limites (nesta documentação)

Não estão decididos como parte do produto: painel web, banco próprio, número WhatsApp separado da Alana. Premissas antigas em `docs/especificacao/fase-1.md` não valem como requisitos fechados.
