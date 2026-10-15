# Pendências do piloto (antes de desenvolver)

Itens da especificação, seção 14. Preencher com Alana / operação.

## 1. WhatsApp Business

- [ ] Número oficial do piloto
- [ ] Conta / negócio responsável
- [ ] Quem administra o Meta Business

## 2. Motoristas e caminhões do piloto

- [ ] Motorista 1 — nome e WhatsApp
- [ ] Caminhão 1 — placa e apelido
- [ ] Motorista 2 — nome e WhatsApp
- [ ] Caminhão 2 — placa e apelido

## 3. Conta Google

- [ ] Conta que hospeda Drive e Sheets
- [ ] Pasta raiz da operação
- [ ] Planilha operacional (nova ou existente)

## 4. Categorias

Piloto: frete, combustível, manutenção.

- [ ] Precisa de subcategorias já no piloto? Quais?

## 5. Fretes

- [ ] Cadastrar fretes no sistema desde o início
- [ ] Ou só vincular manualmente na revisão

## 6. Rotina com Alana

- [ ] Validar tela de confirmação
- [ ] Combinar rotina diária (quem revisa, em que horário)

## 7. Ciclo 3 — silêncio no grupo vs aviso no privado (2026-10-08)

Combinado na operação: no **grupo** o bot é vigia (não responde). `LIVE_SEND` no grupo permanece off.

Aviso operacional curto vai **só no privado do admin** (Derek / Alana), nunca no grupo. Exemplo: `TFA setembro: foto 23/09 sem valor — conferir`. Sem JID cru no texto.

Gate: `ADMIN_ALERT_JID` tem de ser 1:1 (`@c.us`), estar na allowlist, e `LIVE_SEND=true` só libera esse DM — grupo continua bloqueado pelo `decideSend` (`not_test_group` / live send off). Enquanto o gate não estiver armado, a linha fica `incompleto` e o log é `admin_alert_pending`. Não soltar mensagem no grupo “para testar”.
