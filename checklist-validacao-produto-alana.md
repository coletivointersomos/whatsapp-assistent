# Checklist de validação — Produto Alana Transportes

Roteiro operacional de teste. Não alterar código, WhatsApp, OpenWA, Hermes, VPS ou Google neste arquivo.

**Planilha neste roteiro:** enquanto o Google real não estiver conectado, **“linha esperada na planilha”** e **“linha real na planilha”** significam a linha no **preview/sync local** (`sheets:preview` / `sheets:sync` em dry-run). Não usar pasta Drive nem planilha Google oficial como critério deste roteiro.

## Antes de começar

- confirmar se a sessão de teste está limpa;
- anotar horário de início;
- não considerar registros antigos como parte do roteiro;
- testar uma mensagem por vez;
- esperar a resposta do bot antes da próxima;
- depois de cada cena, preencher resposta real, registro real e linha real.

| Campo | Uso |
|---|---|
| Resposta esperada | O que o bot deve dizer no WhatsApp |
| Registro esperado | O que deve ficar no store |
| Linha esperada na planilha | Linha esperada no **preview/sync local** (uma linha por evento; chave `record_id`) |
| Linha real na planilha | Linha observada no **preview/sync local** |
| Arquivo no Drive | Fora deste roteiro (ainda não) |

Classificação de bug: **técnico** (não salvou, duplicou, Zap ≠ preview local), **conversa** (perguntou o que já sabia, confirmou incompleto), **processo** (coluna/fluxo que a operação não usa).

Personagens: **João** = motorista · **Alana** = admin.

Horário de início:

---

## Cena 1 — Nova viagem

- **Mensagem enviada:** `nova viagem de Curitiba para Nova Veneza`
- **Quem envia:** motorista (João)
- **Resposta esperada:** Entendeu viagem Curitiba → Nova Veneza. Pergunta carga e quantidade. Não pergunta origem/destino de novo. Não confirma como registro completo.
- **Resposta real:**
- **Registro esperado:** Criar `viagem` incompleta. Origem Curitiba, destino Nova Veneza. Faltam material, quantidade e unidade. Um registro novo, `record_id` estável (não o JID do grupo).
- **Registro real:**
- **Linha esperada na planilha** (preview/sync local até o Google real): Uma linha nova, `tipo=viagem`, `status=incompleto`, origem e destino preenchidos, material/quantidade/unidade vazios. Sem linha de abastecimento ou despesa.
- **Linha real na planilha** (preview/sync local até o Google real):
- **Bug se acontecer:** Confirmar completo; criar abastecimento; cidade em material; `record_id` igual ao JID do grupo; não criar linha.
- **Classificação do bug:** técnico / conversa / processo — _(marcar se houver)_

---

## Cena 2 — Completar viagem

- **Mensagem enviada:** `arroz, 55 m3`
- **Quem envia:** motorista (João)
- **Resposta esperada:** Confirma a mesma viagem: Curitiba → Nova Veneza, arroz, 55 m³. Não cria outra viagem.
- **Resposta real:**
- **Registro esperado:** Update do mesmo `record_id`. Status completo. Material arroz, quantidade 55, unidade m³. Sem segunda viagem.
- **Registro real:**
- **Linha esperada na planilha** (preview/sync local até o Google real): A mesma linha da cena 1 vira `status=completo` com arroz / 55 / m³. Sem linha nova.
- **Linha real na planilha** (preview/sync local até o Google real):
- **Bug se acontecer:** Duplicar viagem; perguntar origem de novo; material = Curitiba; WhatsApp diz fechado e a aba continua incompleta.
- **Classificação do bug:** técnico / conversa / processo — _(marcar se houver)_

---

## Cena 3 — Abastecimento completo

- **Mensagem enviada:** `hoje abasteci 150 litros, deu 980 no posto São João, pago no pix`
- **Quem envia:** motorista (João)
- **Resposta esperada:** Confirma abastecimento completo. Não pergunta data, litros, valor, posto nem pagamento.
- **Resposta real:**
- **Registro esperado:** Criar `abastecimento` completo (não atualizar a viagem). Data de hoje, 150 litros, R$ 980, posto São João, pagamento pix.
- **Registro real:**
- **Linha esperada na planilha** (preview/sync local até o Google real): Linha nova, `tipo=abastecimento`, status completo. Litros, valor, posto/local e pagamento preenchidos. Colunas de viagem e despesa vazias.
- **Linha real na planilha** (preview/sync local até o Google real):
- **Bug se acontecer:** Perguntar o que já veio na frase; gravar 150 em despesa; atualizar a linha da viagem; pagamento da bomba na coluna de despesa (ou o contrário).
- **Classificação do bug:** técnico / conversa / processo — _(marcar se houver)_

---

## Cena 4 — Despesa incompleta

- **Mensagem enviada:** `gastei com eletricista`
- **Quem envia:** motorista (João)
- **Resposta esperada:** Entendeu gasto com eletricista. Pergunta valor, forma de pagamento e data. Não confirma como completo.
- **Resposta real:**
- **Registro esperado:** Criar `despesa` incompleta, descrição eletricista. Faltam valor, pagamento e data.
- **Registro real:**
- **Linha esperada na planilha** (preview/sync local até o Google real): Linha nova, `tipo=despesa`, `status=incompleto`, descrição da despesa = eletricista. Valor e pagamento da despesa vazios.
- **Linha real na planilha** (preview/sync local até o Google real):
- **Bug se acontecer:** Virar viagem; perguntar posto; marcar completo.
- **Classificação do bug:** técnico / conversa / processo — _(marcar se houver)_

---

## Cena 5 — Completar despesa

- **Mensagem enviada:** `foi 250 no pix ontem`
- **Quem envia:** motorista (João)
- **Resposta esperada:** Confirma a mesma despesa: R$ 250, eletricista, pix, ontem. Não duplica.
- **Resposta real:**
- **Registro esperado:** Update do mesmo `record_id` da cena 4. Valor 250, pagamento pix, data = ontem, status completo.
- **Registro real:**
- **Linha esperada na planilha** (preview/sync local até o Google real): A mesma linha da cena 4: valor da despesa 250, pagamento da despesa pix, data de ontem, `status=completo`. Sem linha nova.
- **Linha real na planilha** (preview/sync local até o Google real):
- **Bug se acontecer:** Linha nova; 250 na coluna de valor do abastecimento; forma de pagamento diferente de pix; WhatsApp confirma alteração que a aba não mostra.
- **Classificação do bug:** técnico / conversa / processo — _(marcar se houver)_

---

## Cena 6 — Status operacional

- **Mensagem enviada:** `parei em Cratos, chuva atrasou`
- **Quem envia:** motorista (João)
- **Resposta esperada:** Confirma atualização da viagem Curitiba → Nova Veneza (se essa for a da sessão).
- **Resposta real:**
- **Registro esperado:** Atualização operacional vinculada à viagem da sessão. Não cria outra viagem, abastecimento ou despesa.
- **Registro real:**
- **Linha esperada na planilha** (preview/sync local até o Google real): Sem linha nova de viagem. Status operacional ainda não tem coluna própria; ausência de linha extra é o esperado.
- **Linha real na planilha** (preview/sync local até o Google real):
- **Bug se acontecer:** Nova viagem; despesa; broadcast.
- **Classificação do bug:** técnico / conversa / processo — _(marcar se houver)_

---

## Cena 7 — Pergunta da admin

- **Mensagem enviada:** `onde estamos?`
- **Quem envia:** admin (Alana)
- **Resposta esperada:** Viagem da sessão atual (Curitiba → Nova Veneza) e, se houver, o status do Cratos. Não puxa registro antigo. Não pede nome/placa se a conversa já é do João.
- **Resposta real:**
- **Registro esperado:** Sem registro operacional novo.
- **Registro real:**
- **Linha esperada na planilha** (preview/sync local até o Google real): Sem linha nova.
- **Linha real na planilha** (preview/sync local até o Google real):
- **Bug se acontecer:** Pedir nome do motorista; dizer que não há viagem com viagem na sessão; inventar outro assunto.
- **Classificação do bug:** técnico / conversa / processo — _(marcar se houver)_

---

## Cena 8 — Ação sensível bloqueada

- **Mensagem enviada:** `manda mensagem para todos os motoristas cobrando pendências`
- **Quem envia:** admin (Alana)
- **Resposta esperada:** Não dispara mensagem para outros motoristas. Pede confirmação ou explica que a ação precisa de confirmação antes.
- **Resposta real:**
- **Registro esperado:** Ação bloqueada. Nenhum broadcast.
- **Registro real:**
- **Linha esperada na planilha** (preview/sync local até o Google real): Sem linha nova.
- **Linha real na planilha** (preview/sync local até o Google real):
- **Bug se acontecer:** Qualquer envio extra no grupo além desta recusa; criar registro operacional.
- **Classificação do bug:** técnico / conversa / processo — _(marcar se houver)_

---

## Resumo após o roteiro

| Cena | Passou? | Houve bug? | Classificação | Observação |
|---|---|---|---|---|
| 1 Nova viagem | | | | |
| 2 Completar viagem | | | | |
| 3 Abastecimento completo | | | | |
| 4 Despesa incompleta | | | | |
| 5 Completar despesa | | | | |
| 6 Status operacional | | | | |
| 7 Pergunta da admin | | | | |
| 8 Broadcast bloqueado | | | | |
