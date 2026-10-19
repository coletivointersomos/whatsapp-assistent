/**
 * Classificador determinístico dos lançamentos da folha (rascunho → oficial).
 * Regras do SKILL monitoramento-caminhao-whatsapp §5; ordem importa (primeira que casa vence).
 *
 *   frete         = record "viagem" (tipo de linha continua "viagem": é o bloco VIAGENS)
 *   abastecimento = forma à vista ("abastecimento_vista") ou a prazo ("abastecimento_prazo")
 *   adiantamento  = adiantamento ao motorista
 *   pedagio       = pedágio / vale-pedágio
 *   balanca       = balança / pesagem
 *   deposito      = motorista depositou / saldo de frete / cliente pagou frete na conta
 *   pagamento     = Pix/transferência de acerto para a empresa (não é gasto)
 *   despesa       = demais gastos do caminhão
 */
export type DespesaClasse = "adiantamento" | "pedagio" | "balanca" | "deposito" | "pagamento" | "despesa";
export type AbastecimentoForma = "abastecimento_vista" | "abastecimento_prazo";

function norm(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** Palavras de gasto: se aparecem, Pix é só a forma de pagar a despesa. */
const GASTO = /borrach|pneu|laudo|danfe|oficina|mecanic|peca|lavagem|lava jato|caderno|diesel|posto|alimenta|refeic|almoco|janta|hotel|pousada|chapa|eletric|lona|corda|oleo|filtro/;

export function classifyDespesa(description?: string, note?: string, payment?: string): DespesaClasse {
  const text = norm(`${description ?? ""} ${note ?? ""}`);
  const pay = norm(payment ?? "");
  if (/adiantament/.test(text)) return "adiantamento";
  if (/pedagio|vale[- ]?ped/.test(text)) return "pedagio";
  if (/balanca|pesagem/.test(text)) return "balanca";
  if (/deposit|saldo d[eo] frete|frete recebid|cliente (pagou|depositou)/.test(text)) return "deposito";
  const pixLike = /\bpix\b|transferencia|\bted\b/.test(`${text} ${pay}`);
  const acerto = /para (o )?arnaldo|\bacerto\b|equivalente ao (meu )?debito|repasse/.test(text);
  if (acerto || (pixLike && !GASTO.test(text) && /\bpix\b|transferencia|\bted\b|pagamento/.test(text))) return "pagamento";
  return "despesa";
}

export function classifyAbastecimento(payment?: string, note?: string): AbastecimentoForma {
  const pay = norm(payment ?? "");
  if (/prazo|fiado|assinad|faturad|nao pag|boleto|pendente/.test(pay)) return "abastecimento_prazo";
  if (pay.trim()) return "abastecimento_vista";
  const extra = norm(note ?? "");
  return /a prazo|fiado|assinad|faturad|nao pag/.test(extra) ? "abastecimento_prazo" : "abastecimento_vista";
}

/** Tipo antigo (antes do 2c) — base da impressão digital, para não duplicar linhas já gravadas. */
export function legacyTipo<T extends string>(tipo: T): T | "despesa" {
  return tipo === "pedagio" || tipo === "balanca" || tipo === "adiantamento" || tipo === "pagamento" ? "despesa" : tipo;
}
