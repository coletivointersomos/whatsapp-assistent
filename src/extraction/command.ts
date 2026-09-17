export type ParsedCommand =
  | {
      type: "suspend";
      driverName: string;
      start: string;
      end: string;
      ambiguous: false;
    }
  | { type: "list"; ambiguous: false }
  | { type: "none"; ambiguous: false }
  | { type: "ambiguous"; reason: string; ambiguous: true };

const DATE = "(20\\d{2}-\\d{2}-\\d{2})";

export function parseCentralCommand(text: string): ParsedCommand {
  const list = text.match(/^\s*listar suspens/i);
  if (list) return { type: "list", ambiguous: false };

  const full = text.match(
    new RegExp(
      `suspender\\s+motorista\\s+(.+?)\\s+de\\s+${DATE}\\s+at[eé]\\s+${DATE}`,
      "i",
    ),
  );
  if (full) {
    return {
      type: "suspend",
      driverName: full[1].trim(),
      start: full[2],
      end: full[3],
      ambiguous: false,
    };
  }

  if (/\bsuspender\b/i.test(text)) {
    return {
      type: "ambiguous",
      reason:
        "Informe o motorista e o período no formato: suspender motorista NOME de AAAA-MM-DD até AAAA-MM-DD",
      ambiguous: true,
    };
  }

  return { type: "none", ambiguous: false };
}

export function questionForMissing(
  kind: string,
  missing: string[],
  hint?: { description?: string },
): string {
  if (kind === "despesa") {
    const name = hint?.description?.trim() ? ` com ${hint.description.trim()}` : "";
    const needVal = missing.includes("amountBrl");
    const needDate = missing.includes("date");
    const needPay = missing.includes("payment");
    if (needVal && (needPay || needDate)) {
      if (needPay) return `Entendi o gasto${name}. Qual foi o valor e como foi pago?`;
      return `Entendi o gasto${name}. Qual foi o valor e em que dia aconteceu?`;
    }
    if (needVal) return `Qual foi o valor desse gasto${name}?`;
    if (missing.includes("description") && needPay) return "O que foi? Foi pago ou assinada?";
    if (missing.includes("description")) return "O que foi essa despesa?";
    if (needPay) return "Foi pago ou ficou assinada?";
    if (needDate) return "Foi hoje ou outro dia?";
  }

  const same = (...keys: string[]) =>
    missing.length === keys.length && keys.every((key) => missing.includes(key));

  if (same("place")) return "Qual foi o posto?";
  if (same("date")) return "Foi hoje ou outro dia?";
  if (same("date", "place")) return "Foi hoje? E qual foi o posto?";
  if (same("payment")) return "Foi pago ou ficou assinada?";
  if (same("origin", "destination")) return "Qual foi a origem e o destino?";
  if (same("origin")) return "Qual foi a origem?";
  if (same("destination")) return "Qual foi o destino?";
  if (same("description")) return "O que foi essa despesa?";
  if (same("description", "payment")) return "O que foi? Foi pago ou assinada?";
  if (same("amountBrl") || same("totalBrl")) return "Qual foi o valor?";
  if (same("liters")) return "Quantos litros?";
  if (same("material")) return "Qual foi o material?";
  if (same("quantity") || same("unit") || same("quantity", "unit")) {
    return "Quantas toneladas ou m³?";
  }
  if (same("date", "material")) return "Foi hoje? Qual foi o material?";

  const first = missing[0];
  if (first === "date") return "Foi hoje ou outro dia?";
  if (first === "place") return "Qual foi o posto?";
  if (first === "payment") return "Foi pago ou ficou assinada?";
  if (first === "origin") return "Qual foi a origem?";
  if (first === "destination") return "Qual foi o destino?";
  if (first === "description") return "O que foi essa despesa?";
  if (first === "material") return "Qual foi o material?";
  if (first === "quantity" || first === "unit") return "Quantas toneladas ou m³?";
  if (first === "liters") return "Quantos litros?";
  if (first === "amountBrl" || first === "totalBrl") return "Qual foi o valor?";
  return "Pode completar o que faltou?";
}

export function confirmationForKind(kind: string): string {
  if (kind === "despesa") return "Fechado, registrei essa despesa.";
  if (kind === "viagem") return "Fechado, registrei essa viagem.";
  return "Fechado, registrei esse abastecimento.";
}

export function confirmationForRecord(kind: string, record: { despesa?: { amountBrl?: number; description?: string; payment?: string } }): string {
  if (kind !== "despesa" || !record.despesa) return confirmationForKind(kind);
  const d = record.despesa;
  const bits: string[] = [];
  if (d.amountBrl !== undefined) bits.push(`de R$ ${d.amountBrl}`);
  if (d.description) bits.push(`com ${d.description}`);
  if (d.payment === "pix") bits.push("no pix");
  else if (d.payment === "assinada") bits.push("como assinada");
  else if (d.payment === "pago") bits.push("pago");
  else if (d.payment) bits.push(`no ${d.payment}`);
  if (!bits.length) return confirmationForKind("despesa");
  return `Fechado, registrei essa despesa ${bits.join(" ")}.`;
}
