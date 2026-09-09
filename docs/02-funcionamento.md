# 02 — Funcionamento

Contexto de produto: `docs/01-produto.md`. Decisões em aberto e checklist: `docs/03-pendencias-e-validacao.md`.

## Coleta proativa

O assistente acompanha as conversas autorizadas e toma a iniciativa de pedir registros ou dados faltantes.

**Frequência no piloto:** diária. Pode mudar para semanal conforme o teste. Faixa de horário e fuso: ainda abertos → doc 03.

Tipos a coletar: **viagens**, **abastecimentos** e **outras despesas**. Frete não entra automaticamente como despesa.

Nas viagens, além dos campos da folha, preservar quando informados: preço por unidade, valor total do frete e informações de recebimento (aparecem nas anotações, mesmo sem coluna própria). Separar **pagamento de despesa** de **recebimento de frete**.

Marcações de pagamento incluem termos como “pago” e “assinada”. Não interpretar “assinada” como “pago” (significado operacional pendente → doc 03).

Não exigir que o motorista repita dados já conhecidos ou já ditos na conversa. Não inventar ausentes nem transformar toda anotação livre em funcionalidade nova.

Exemplo:

> Bot → Motorista: “Oi, tem algum registro de hoje para passar?”  
> Motorista → Bot: “Abasteci 200 reais no posto X.”

## Informações faltantes

Se a resposta estiver incompleta, o assistente pergunta só o que falta. Não inventa valores, datas, caminhão, quantidade, unidade ou comprovante.

Exemplo:

> Motorista: “Abasteci ontem.”  
> Bot: “Qual o valor e o posto?”

## Motorista indisponível

Respostas como “não consigo falar agora” interrompem a insistência. Retomada segue regra a definir (doc 03) — não assumir cobrança imediata nem acumulada indevida.

Exemplo:

> Motorista: “Agora não consigo.”  
> Bot: (para de insistir; agenda retomada conforme regra aprovada)

## Lembretes

Lembretes existem para silêncio ou falta de registro, dentro de limites a combinar (quantidade, intervalo). Números concretos ainda não são decisão final → doc 03.

## Participação da Alana

Alana pode conversar direto com o motorista. Motoristas não emitem comandos administrativos que alterem a operação dos demais.

**Pausa por intervenção humana** (diferente de suspensão pela central):

| Regra | Comportamento |
|---|---|
| Gatilho | Alana envia mensagem na conversa do motorista |
| Duração | 15 minutos contados da **última** mensagem dela |
| Durante a pausa | Bot não responde; continua acompanhando as mensagens |
| Retomada | Automática, sem comando explícito e **sem anunciar** que voltou |
| Após retomar | Só pergunta se ainda houver pendência, considerando o que motorista e Alana já resolveram |

## Pausa e retomada do bot

| Situação | Efeito esperado |
|---|---|
| Intervenção da Alana na conversa | Pausa de 15 min (regra acima) |
| Suspensão pela central de comando | Respeita o **período determinado**; não usa a regra dos 15 min |
| Pausa global (se existir) | Afeta todas as coletas; quem pode acionar: a definir |

## Central de comando

Conversa administrativa separada (nome provisório). Só identidades autorizadas (Alana) mudam regras.

Ação confirmada como exemplo: suspender contatos automáticos de um motorista por um período (ex.: uma semana sem trabalhar).

| Regra | Comportamento |
|---|---|
| Referência ambígua (“motorista do caminhão um”, “semana que vem”) | Pedir esclarecimento antes de alterar |
| Confirmação | Só anunciar sucesso depois de aplicar de forma verificável |
| Histórico | Registrar autor, alteração, período e resultado (como consultar/cancelar: a definir) |
| Fim da suspensão | Seguir o período combinado; sem disparar cobranças acumuladas indevidas |

Formato técnico da central (chat consigo mesma, grupo, outro número, etc.): a verificar com Hermes → doc 03.
