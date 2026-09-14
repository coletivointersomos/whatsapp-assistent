# Assistente WhatsApp — Alana Transportes

Documentação do produto em `docs/`. Fundação local da Fase 1 em `src/` (sem Hermes, WhatsApp, Google ou VPS reais). Integração Hermes/VPS fica para uma etapa futura de comparação/adaptação.

## Demonstração

```bash
npm install
npm test
npm run typecheck
npm run simulate
npm run schedule:preview
npm run sheets:preview
```

`schedule:preview` e `sheets:preview` usam um estado demo previsível. Se existir `data/store.json`, eles leem esse arquivo; `--demo` força o demo.

Um cenário do simulador: `npm run simulate -- --file fixtures/abastecimento-completo.json`

## Stack

Node.js + TypeScript. Persistência JSON local. Extração determinística (sem IA).

## Pastas

| Pasta | Para quê |
|---|---|
| `docs/` | Produto, funcionamento, pendências, spec do MVP |
| `src/` | Domínio, extração, engine, persistência, CLI, previews |
| `fixtures/` | Mensagens simuladas |
| `tests/` | Fluxos da fundação e previews |
