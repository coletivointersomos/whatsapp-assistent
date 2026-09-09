# 03 — Pendências e validação

Produto: `docs/01-produto.md` · Funcionamento: `docs/02-funcionamento.md`

## Decisões ainda abertas

| Tema | Por que importa |
|---|---|
| Comprovantes digitais (foto/áudio) no piloto? | Escopo de mídia e armazenamento |
| Faixa de horário e fuso da coleta diária | Agenda de contatos |
| Limites de lembretes e tratamento de silêncio | Evitar insistência excessiva |
| Retomada após “agora não” | Quando e como voltar a falar |
| Significado operacional de “assinada” (≠ “pago”) | Status de pagamento nas folhas |
| Forma da central de comando | Onde Alana dá comandos |
| Como consultar/corrigir/cancelar suspensões | Operação segura da central |
| Destino dos registros após coleta (Sheets, outro, só conversa) | Trabalho de consolidação da Alana |
| Pausa global (existe? quem aciona?) | Escopo além da pausa por conversa |

**Já definido (ver docs 01 e 02):** estrutura dos campos do papel; coleta diária no piloto (com opção de semanal); tipos viagem / abastecimento / despesa; frete ≠ despesa automática; pausa de 15 min após mensagem da Alana, com retomada silenciosa e acompanhamento durante a pausa; suspensão da central pelo período determinado.

Não tratar como fechado: painel web, banco próprio, número WhatsApp separado.

## Hermes — capacidades a verificar

Sem conectar serviços nesta etapa. Registrar evidência (produto, versão ou data da doc) quando houver.

| Capacidade | Precisa para |
|---|---|
| Operar no WhatsApp pessoal/negócio da Alana | Premissa do canal |
| Restringir acesso às conversas autorizadas (isolamento real, não só filtro depois) | Requisito de acesso |
| Ouvir novas mensagens e enviar proativamente | Coleta e faltantes |
| Pausar respostas 15 min após mensagem da Alana, continuar ouvindo e retomar sem anunciar | Coexistência |
| Agendar/respeitar suspensões por período (central) | Suspensão ≠ pausa de 15 min |
| Suportar a central de comando no arranjo escolhido | Comandos administrativos |

Se alguma capacidade for inviável, documentar bloqueio e alternativa — sem implementar ainda.

## Checklist simples do piloto

Validar com os dois motoristas autorizados + Alana:

- [ ] Motorista autorizado envia registro (viagem, abastecimento ou despesa) e o fluxo combinado é seguido
- [ ] Registro incompleto gera pergunta só do dado faltante; dados já conhecidos não são pedido de novo
- [ ] “Agora não consigo” para a insistência e segue a regra de retomada
- [ ] Alana manda mensagem na conversa: bot fica 15 min sem responder, acompanha, retoma sem anunciar e só pergunta o que ainda falta
- [ ] Alana suspende um motorista por um período via central; contatos automáticos respeitam esse período (não a regra dos 15 min)
- [ ] Referência ambígua a pessoa/período gera esclarecimento antes de alterar
- [ ] Conversas não autorizadas ficam fora do acesso permitido (ou limitação técnica registrada como bloqueio)
- [ ] Motorista não altera a operação dos demais via comando
- [ ] Frete/recebimento não é misturado com pagamento de despesa; “assinada” não é tratada como “pago”
- [ ] Mensagens repetidas / falha de integração não geram confirmação financeira duplicada nem sucesso fictício
- [ ] Fim da suspensão retoma sem cobranças acumuladas indevidas

Condição sugerida para ir de 2 para 6 motoristas: checklist acima ok na prática e Alana confortável com a rotina de consolidação.
