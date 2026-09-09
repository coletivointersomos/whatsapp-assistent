# 04 — Especificação técnica do MVP

Produto: `docs/01-produto.md` · Comportamento: `docs/02-funcionamento.md` · Pendências: `docs/03-pendencias-e-validacao.md`

**Status:** spec da primeira entrega implementável · **Não autoriza** painel, banco em produção, deploy ou integração Hermes real.

## 1. Objetivo do MVP técnico

Provar, em ambiente local e simulável, o menor ciclo: mensagem autorizada → registro extraído (completo ou incompleto) → pergunta só do que falta → respeito a pausa da Alana e a suspensão da central.

O WhatsApp da Alana e o Hermes entram depois, quando houver evidência das capacidades (seção 9). Até lá, entrada e saída são simuladas (arquivo, CLI ou mensagens fake).

## 2. Escopo incluído

- Dois motoristas autorizados + uma conversa de central (identidades configuráveis).
- Três tipos de registro: abastecimento, despesa, viagem/frete (frete **não** é despesa).
- Persistência mínima local só para o ciclo acima (arquivo JSON/SQLite de desenvolvimento — escolha na etapa de código, não agora).
- Extração a partir de texto. Áudio = forma de informar (no MVP: transcrição simulada ou texto equivalente). Foto de comprovante = anexo opcional, não misturado com áudio.
- Pausa de 15 min por intervenção da Alana; suspensão por período via central.
- Comando da central: suspender coleta de um motorista por um período explícito.

## 3. Escopo fora desta etapa

Painel web, autenticação, fila/worker, dashboard, deploy, Drive/Sheets, número WhatsApp separado, webhook Meta como decisão, isolamento Hermes não validado, pausa global, lembretes com quantidade inventada, confirmação financeira automática, armazenamento real de mídia.

Comprovantes digitais, faixa de horário/fuso, retomada de “agora não”, formato físico da central: pendências do doc 03 — não fechar aqui.

## 4. Fluxos principais

| # | Fluxo | Resultado |
|---|---|---|
| A | Motorista autorizado envia texto com registro | Mensagem persistida; registro criado (completo ou incompleto) |
| B | Registro incompleto | Uma pergunta só dos campos faltantes obrigatórios para aquele tipo |
| C | “Agora não consigo” | Para insistência; não cobra de novo na mesma rodada (retomada: pendência doc 03) |
| D | Alana fala na conversa do motorista | Pausa respostas 15 min a partir da última mensagem dela; continua registrando o que chegar |
| E | Fim da pausa D | Retoma sem anunciar; pergunta só se ainda houver pendência não resolvida na conversa |
| F | Central: suspender motorista por período | Só após pessoa e período explícitos; aplica; só então confirma |
| G | Conversa não autorizada | Ignorada (simulação: não entra na lista). Isolamento real = Hermes |
| H | Motorista tenta comando de central | Recusado; não altera regras |

## 5. Modelo de dados conceitual

Sem schema físico nem migrações. IDs opacos. Não inventar campos ausentes.

**Conversaautorizada:** `id`, `papel` (`motorista` \| `central`), `identificador_externo` (placeholder até Hermes), `motorista_id` (se motorista), `ativa`.

**Motorista:** `id`, `nome`, `veiculo_hint` opcional (placa/apelido conhecidos).

**Mensagem:** `id`, `conversa_id`, `autor` (`motorista` \| `alana` \| `bot` \| `desconhecido`), `enviada_em`, `tipo` (`texto` \| `audio_info` \| `anexo_comprovante`), `corpo` ou referência de anexo, `bruta` (payload simulado). Áudio e comprovante são tipos distintos.

**Registro:** `id`, `tipo` (`abastecimento` \| `despesa` \| `viagem`), `motorista_id`, `veiculo` opcional, `estado` (`incompleto` \| `completo` \| `descartado`), `origem_mensagem_ids[]`, `campos` (abaixo), `pendencias[]` (nomes dos campos faltantes). Frete/recebimento, se informados na viagem, ficam em campos da viagem — **não** viram `despesa`.

Campos por tipo (obrigatórios para `completo` só os da coluna do papel; o resto é opcional se vier na fala):

| Tipo | Obrigatórios para completo | Opcionais se informados |
|---|---|---|
| Abastecimento | data, litros, valor_total_brl, local, pagamento | observação, veículo |
| Despesa | data, valor_brl, descrição, pagamento | observação, veículo |
| Viagem | data, origem, destino, material, quantidade, unidade | observação, veículo, preco_unidade, valor_frete, recebimento |

`pagamento` guarda o texto informado (`pago`, `assinada`, outro). **Não** mapear `assinada` → `pago`.

**PausaConversacao:** `conversa_id`, `motivo` (`intervencao_alana`), `silencio_ate` (última mensagem da Alana + 15 min).

**Suspensao:** `id`, `motorista_id`, `inicio`, `fim`, `autor` (Alana), `estado` (`aplicada` \| `encerrada` \| `cancelada`), `texto_comando`. Suspensão **prevalece** sobre coleta diária e sobre a pausa de 15 min.

**ComandoCentral:** `id`, `mensagem_id`, `interpretacao`, `estado` (`ambigua` \| `aplicada` \| `recusada` \| `falha`). Nunca `aplicada` antes da mudança persistida.

## 6. Regras de comportamento do bot

- Só conversas na lista autorizada.
- Não inventar data, valor, litros, quantidade, unidade, local, caminhão ou comprovante.
- Não pedir de novo o que já está no registro ou na conversa recente.
- Um registro incompleto → no máximo uma pergunta direcionada por turno.
- Coleta do piloto: **diária** (horário/fuso: pendência). Se o motorista estiver suspenso, não dispara coleta.
- Áudio informa conteúdo; foto de comprovante anexa. Não usar um no lugar do outro.
- Mensagem repetida / reprocessamento: não criar segundo registro financeiro equivalente; idempotência pelo id da mensagem simulada.

## 7. Regras da central de comando

- Só `papel = central` e identidade Alana alteram regras. Mensagem de motorista não é autorização.
- Ação do MVP: suspender (e, se der no mesmo modelo, encerrar/cancelar) coleta de **um** motorista num **período**.
- “Motorista do caminhão 1” / “semana que vem” → perguntar até nome/id e datas explícitas.
- Respostas: entendimento provisório ≠ aplicado. Só anunciar sucesso depois de gravar `Suspensao` com `estado = aplicada`.
- Conflito: suspensão vigente ganha da coleta e da retomada pós-pausa de 15 min.
- Consultar/listar suspensões ativas: desejável no MVP se couber num comando; senão pendência, não inventar UI.

## 8. Regras de pausa e retomada

| Evento | Efeito |
|---|---|
| Alana envia mensagem na conversa do motorista | Recalcula `silencio_ate` = agora + 15 min; bot não envia |
| Durante a pausa | Persiste mensagens e atualiza registros; não responde |
| Relógio atinge `silencio_ate` e não há suspensão | Pode enviar de novo **sem** dizer que voltou; só se `pendencias` ainda existirem |
| Suspensão ativa no período | Não envia coleta nem pergunta de faltante |

Pausa de 15 min ≠ suspensão da central.

## 9. Pontos dependentes do Hermes

Não assumir produto, versão, WhatsApp Business/pessoal, grupo, chat consigo mesma ou webhook.

Precisa de evidência (doc + data) antes de integrar:

| Capacidade | Se faltar |
|---|---|
| Rodar no WhatsApp da Alana | Bloqueio de canal real |
| Isolar conversas autorizadas de verdade (não só filtrar depois de receber o resto) | Bloqueio de acesso; simulação não prova isso |
| Ler e enviar nas conversas autorizadas | Coleta e faltantes reais |
| Distinguir mensagem da Alana vs motorista na mesma conversa | Pausa de 15 min |
| Entregar a central no arranjo escolhido | Comandos reais |
| Agendar ou permitir que o app agende retomada/suspensão | Relógio pode ficar no app local |

**Simulável agora:** lista autorizada, mensagens fake, extração, pausa por timestamp, suspensão por datas, recusa de comando de motorista.

## 10. Plano de implementação em etapas pequenas

Cada etapa só depois de autorização explícita. Uma de cada vez.

1. Modelo em memória/arquivo + motoristas autorizados + ingestão de mensagem simulada.
2. Extração para os três tipos + estados incompleto/completo + pergunta de faltante (sem IA obrigatória: regras/heurística; IA só se etapa futura pedir).
3. Pausa 15 min (relógio testável, sem WhatsApp).
4. Central: suspender com desambiguação e confirmação pós-aplicação.
5. Coleta diária simulada respeitando suspensão e pausa.
6. Adaptador Hermes — **somente** após checklist da seção 9.

## 11. Critérios de aceite do MVP

Demonstráveis em simulação, sem Hermes:

- [ ] Registro completo de motorista autorizado segue o fluxo A e fica `completo`
- [ ] Incompleto gera uma pergunta do dado faltante (fluxo B)
- [ ] “Agora não” interrompe insistência (fluxo C)
- [ ] Mensagem da Alana silencia o bot 15 min; monitoramento continua; retomada sem anúncio e só se houver pendência
- [ ] Suspensão por período bloqueia coleta desse motorista; fim do período não dispara fila atrasada de cobranças
- [ ] Referência ambígua na central pede esclarecimento; sucesso só após aplicar
- [ ] Não autorizado e comando de motorista não mudam a operação
- [ ] Viagem não vira despesa; `assinada` permanece `assinada`
- [ ] Áudio e comprovante não são o mesmo tipo
- [ ] Reprocessar a mesma mensagem não duplica registro

Este documento não autoriza a etapa 1 de código.
