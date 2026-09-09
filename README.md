# Assistente WhatsApp — Alana Transportes

Documentação do produto em `docs/`. Fundação local da Fase 1 (sem Hermes/WhatsApp reais) na pasta `src/`.

## Rodar localmente

```bash
npm install
npm test
npm run typecheck
npm run simulate
```

Um cenário: `npm run simulate -- --file fixtures/abastecimento-completo.json`

`--persist` grava `data/store.json` (pasta ignorada pelo git).

## Stack

Node.js + TypeScript. Persistência JSON local. Extração determinística (sem IA).

## Pastas

| Pasta | Para quê |
|---|---|
| `docs/` | Produto, funcionamento, pendências, spec do MVP |
| `src/` | Domínio, extração, engine, persistência, CLI |
| `fixtures/` | Mensagens simuladas |
| `tests/` | Fluxos da fundação |
