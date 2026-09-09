export type ParsedCommand =
  | {
      type: "suspend";
      driverName: string;
      start: string;
      end: string;
      ambiguous: false;
    }
  | { type: "list"; ambiguous: false }
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

  return {
    type: "ambiguous",
    reason: "Não reconheci o comando. Exemplo: suspender motorista João de 2026-09-10 até 2026-09-15",
    ambiguous: true,
  };
}

export function questionForMissing(kind: string, missing: string[]): string {
  const labels: Record<string, string> = {
    date: "data",
    liters: "litros",
    totalBrl: "valor total",
    place: "local/posto",
    payment: "pagamento",
    amountBrl: "valor",
    description: "descrição",
    origin: "origem",
    destination: "destino",
    material: "material",
    quantity: "quantidade",
    unit: "unidade da carga",
  };
  const named = missing.map((k) => labels[k] ?? k);
  if (named.length === 1) return `Qual a ${named[0]}?`;
  if (named.length === 2) return `Faltam ${named[0]} e ${named[1]}. Pode informar?`;
  return `Faltam: ${named.join(", ")}. Pode informar o próximo?`;
}
