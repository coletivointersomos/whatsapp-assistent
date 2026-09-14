/** Respostas curtas, sem LLM. Só frases com intenção clara. */

export const DRIVER_HELLO =
  "Opa. Pode me mandar abastecimento, despesa ou viagem de hoje por aqui.";
export const DRIVER_MORNING =
  "Bom dia. Quando tiver algo do caminhão, pode mandar por áudio ou texto.";
export const DRIVER_WHAT_TO_SEND =
  "Pode mandar abastecimento, despesa ou viagem. Se faltar algum dado, eu pergunto só o necessário.";
export const ADMIN_STATUS =
  "Estou acompanhando este grupo. Posso registrar abastecimentos, despesas e viagens, e pedir o que faltar.";
export const ADMIN_HELP =
  "Posso registrar dados dos motoristas, respeitar pausa da conversa e seguir comandos pela central.";
export const CENTRAL_HELP =
  "Na central, posso suspender coleta por período e listar suspensões.";

function normalizeAssist(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[?!.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchDriverAssist(text: string): string | undefined {
  const n = normalizeAssist(text);
  if (n === "alo") return DRIVER_HELLO;
  if (n === "bom dia") return DRIVER_MORNING;
  if (
    n === "o que eu mando aqui" ||
    n === "o que mando aqui" ||
    n === "o que eu mando"
  ) {
    return DRIVER_WHAT_TO_SEND;
  }
  return undefined;
}

export function matchAdminAssist(text: string): string | undefined {
  const n = normalizeAssist(text);
  if (n === "onde estamos") return ADMIN_STATUS;
  if (n === "ajuda") return ADMIN_HELP;
  return undefined;
}

export function matchCentralAssist(text: string): string | undefined {
  const n = normalizeAssist(text);
  if (n === "ajuda") return CENTRAL_HELP;
  return undefined;
}
