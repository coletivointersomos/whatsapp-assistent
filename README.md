# Assistente WhatsApp — Alana Transportes

Documentação do produto em `docs/`. Fundação em `src/`. Integração Hermes/OpenWA: `docs/05-integracao-hermes-openwa.md`. Planilha local: `docs/06-planilha-preview.md`. Sync dry-run (sem Google): `docs/07-planilha-google.md`. NLU operacional: `docs/08-nlu-assistente-operacional.md`.

## Demonstração

```bash
npm install
npm test
npm run typecheck
npm run simulate
npm run simulate:demo
npm run schedule:preview
npm run sheets:preview
npm run sheets:sync
npm run records:preview
```

`schedule:preview` usa um estado demo previsível. `sheets:preview` gera TSV (`docs/06-planilha-preview.md`). `sheets:sync` mostra o plano insert/update em dry-run (`docs/07-planilha-google.md`); `--apply` está bloqueado. Sem Google nesta etapa. Se existir `data/store.json`, os comandos de planilha leem (não apagam); `--demo` força o demo.

`records:preview` só **lê** `data/store.json` (ou `STORE_PATH` / `--file`). Não apaga nada. Por padrão filtra o `TEST_GROUP_JID` (grupo exclusivo) e as últimas 48h. Use `--all-conversations` e/ou `--all-time` para ver o resto do store (testes antigos misturados).

Um cenário do simulador: `npm run simulate -- --file fixtures/abastecimento-completo.json`

### Evidência — complemento real no grupo exclusivo

Fluxo validado no WhatsApp (grupo exclusivo mascarado `…3923@g.us`, fp `56740fa990`):

1. Motorista: `abasteci 150 litros, deu 980, assinada`
2. Bot: `Foi hoje? E qual foi o posto?`
3. Motorista: `isso, posto jacinto`
4. Bot: `Foi hoje ou outro dia?`
5. Motorista: `hoje`
6. Bot: `Fechado, registrei esse abastecimento.`

Resultado: **um** abastecimento completo; **três** `sourceMessageIds`; posto `posto jacinto`; data = dia do `sentAt`; sem duplicata; respostas só nesse grupo. Detalhe em `docs/05-integracao-hermes-openwa.md` §13.

## Stack

Node.js + TypeScript. Persistência JSON local. Extração determinística (sem IA).

## Pastas

| Pasta | Para quê |
|---|---|
| `docs/` | Produto, funcionamento, pendências, spec do MVP |
| `src/` | Domínio, extração, engine, persistência, CLI, inspeção, previews |
| `fixtures/` | Mensagens simuladas |
| `tests/` | Fluxos da fundação e previews |
