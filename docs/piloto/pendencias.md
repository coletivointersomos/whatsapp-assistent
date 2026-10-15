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

Combinado na operação: no **grupo** o bot é vigia (não responde). `LIVE_SEND=false` no `hermes-arnaldo-transportadora` trava **todo** envio WhatsApp, inclusive 1:1.

**Depois (não agora):** permitir mensagem **só no chat pessoal do admin** (Derek / Alana), nunca no grupo, com alerta operacional curto. Exemplo: `caminhão TFA falta nota de eletricista`.

Isso exige um canal de envio separado do grupo (`TEST_GROUP_JID`): JID 1:1 do admin na allowlist + gate que bloqueia grupo e libera só esse DM. Não misturar com broadcast para motoristas.

Hoje está certo ficar travado no grupo. Não implementar até o monitoramento de setembro/planilha humana estiver validado.
