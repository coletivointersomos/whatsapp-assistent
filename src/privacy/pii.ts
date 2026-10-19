/**
 * Máscara de dados pessoais (PII) para texto que vai ao store ou à planilha.
 *
 * Regras:
 * - CPF → `***.***.***-NN` (só os 2 últimos dígitos).
 * - Telefone e JID WhatsApp → só os 4 últimos dígitos (`…1234`, `…1234@g.us`).
 * - Agência e conta bancária → removidas (`agência [removida]`, `conta [removida]`).
 * - Chave/ID Pix → só os 6 últimos caracteres (`…a1b2c3`). Se a chave for CPF ou
 *   telefone, vale a regra mais restritiva (CPF / 4 últimos).
 *
 * Não mexe em valores em R$, litros, toneladas, datas, placas, CEP, CNPJ solto,
 * nem em números de NF/DANFE/cupom. Funções puras e idempotentes:
 * `maskPii(maskPii(x)) === maskPii(x)`.
 */

/** Marca de valor mascarado. Parsers de dinheiro devem ignorar o que vem depois dela. */
export const MASK_MARK = "…";

const JID_SERVERS = String.raw`(?:c\.us|g\.us|s\.whatsapp\.net|lid|broadcast|newsletter)`;
/** Usuário do JID: só dígitos/hífen (≥5), para não comer o hash do id de mensagem OpenWA. */
const JID_RE = new RegExp(String.raw`(?<![\d-])(\d[\d-]{4,})@(${JID_SERVERS})(?![A-Za-z0-9])`, "gi");

/** Palavras que antecedem número de documento fiscal: o número não é telefone/CPF. */
const DOC_KEYWORD = String.raw`(?:nf-?e?|danfe|cupom|coo|nota(?:\s+fiscal)?|pedido|protocolo|ticket|ct-?e|mdf-?e|chave(?:\s+de\s+acesso)?|n[º°])\s*(?:n[º°o.]*\s*)?[:#\-]?\s*`;
const NOT_AFTER_DOC = String.raw`(?<!${DOC_KEYWORD})`;
/** Número isolado: sem letra/dígito colado e sem outro grupo de dígitos logo antes/depois. */
const ISOLATED_BEFORE = String.raw`(?<![\p{L}\d${MASK_MARK}*])(?<!\d[\s.\-/])`;
const ISOLATED_AFTER = String.raw`(?![\p{L}\d])(?![\s.\-/,]\d)`;

const CPF_FORMATTED_RE = new RegExp(
  String.raw`${ISOLATED_BEFORE}[\d*]{3}\.?[\d*]{3}\.?[\d*]{3}-([\d*]{2})${ISOLATED_AFTER}`,
  "gu",
);
const CPF_BARE_RE = new RegExp(String.raw`${ISOLATED_BEFORE}${NOT_AFTER_DOC}(\d{11})${ISOLATED_AFTER}`, "giu");

const PHONE_PATTERNS = [
  // +55 / 55 com DDD
  String.raw`\+?55[\s.\-]?\(?[1-9]{2}\)?[\s.\-]?9?\d{4}[\s.\-]?\d{4}`,
  // (DD) 9XXXX-XXXX / (DD) XXXX-XXXX
  String.raw`\([1-9]{2}\)\s?9?\d{4}[\s.\-]?\d{4}`,
  // DD 9XXXX-XXXX / DD9XXXXXXXX (celular, 11 dígitos)
  String.raw`[1-9]{2}[\s.\-]?9\d{4}[\s.\-]?\d{4}`,
  // 9XXXX-XXXX (celular sem DDD, com hífen)
  String.raw`9\d{4}-\d{4}`,
];
const PHONE_RE = new RegExp(
  String.raw`${ISOLATED_BEFORE}${NOT_AFTER_DOC}(?:${PHONE_PATTERNS.join("|")})${ISOLATED_AFTER}`,
  "giu",
);

const AGENCY_RE = /(?<![\p{L}])ag(?:[eê]ncia|\.)?(?:\s*n[º°o.]?)?\s*[:\-]?\s*\d{4}(?:-?[\dxX])?(?![\d])/giu;
const ACCOUNT_RES = [
  // conta / c/c / cc + número com dígito verificador
  /(?<![\p{L}])(?:conta(?:\s*-?\s*(?:corrente|poupan[cç]a))?|c\/c|cc)(?:\s*n[º°o.]?)?\s*[:\-]?\s*\d[\d.]{1,14}-[\dxX](?![\d])/giu,
  // conta corrente / poupança + número
  /(?<![\p{L}])conta\s*-?\s*(?:corrente|poupan[cç]a)(?:\s*n[º°o.]?)?\s*[:\-]?\s*\d{4,13}(?![\d.,])/giu,
  // "Conta: 123456" (rótulo de comprovante, ≥5 dígitos, sem centavos)
  /(?<![\p{L}])conta\s*:\s*\d{5,13}(?![\d.,])/giu,
];

const UUID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
const EMAIL = String.raw`[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+`;
const CNPJ = String.raw`\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}`;
const CPF_FMT = String.raw`[\d*]{3}\.[\d*]{3}\.[\d*]{3}-[\d*]{2}`;
const PHONE_ANY = String.raw`\+?(?:55[\s.\-]?)?\(?[1-9]{2}\)?[\s.\-]?9?\d{4}[\s.\-]?\d{4}`;
const ALREADY = String.raw`${MASK_MARK}[^\s,;]{1,6}`;
const PIX_CONTEXT = String.raw`(?<![\p{L}])(?:chave\s+pix|chave\s+aleat[oó]ria|pix|e2e|end\s*to\s*end|id\s+(?:da\s+)?transa[cç][aã]o)`;
const PIX_LABEL = String.raw`(?:\s*(?:[:=\-–]|chave|key|cpf|cnpj|celular|telefone|tel|e-?mail|aleat[oó]ria|copia\s+e\s+cola|id|do|da|de|para)(?![\p{L}]))*\s*`;
const PIX_VALUE = String.raw`(?:${UUID}|${EMAIL}|${CNPJ}|${CPF_FMT}|${PHONE_ANY}|${ALREADY}|\d{8,14}|[A-Za-z0-9]{20,40})`;
const PIX_RE = new RegExp(
  String.raw`(${PIX_CONTEXT}${PIX_LABEL})(${PIX_VALUE})(?![\p{L}\d]|[.,]\d)`,
  "giu",
);
/** ID fim-a-fim Pix (E/D + ISPB 8 + data 12 + 11 alfanum = 32), em qualquer lugar. */
const E2E_RE = /(?<![A-Za-z0-9])[ED]\d{20}[A-Za-z0-9]{11}(?![A-Za-z0-9])/g;
/** Pix copia-e-cola (BR Code EMV). */
const BRCODE_RE = /(?<![A-Za-z0-9])000201\S*?br\.gov\.bcb\.pix\S*/gi;

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

/** Dígitos verificadores de CPF. Rejeita sequências repetidas (000…, 111…). */
export function isValidCpf(value: string): boolean {
  const d = digits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(d[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

export function maskCpfValue(value: string): string {
  const tail = value.replace(/[^\d*]/g, "").slice(-2).padStart(2, "*");
  return `***.***.***-${tail}`;
}

export function maskPhoneValue(value: string): string {
  return `${MASK_MARK}${digits(value).slice(-4)}`;
}

export function maskPixValue(value: string): string {
  const compact = value.replace(/\s+/g, "");
  if (new RegExp(`^${CPF_FMT}$`).test(compact)) return maskCpfValue(compact);
  const phoneLike = /^\+?[\d().\-]+$/.test(compact) && !new RegExp(`^${CNPJ}$`).test(compact);
  if (phoneLike) {
    const d = digits(compact);
    if (/^\d{11}$/.test(compact) && isValidCpf(d)) return maskCpfValue(d);
    if (d.length >= 10 && d.length <= 13) return maskPhoneValue(d);
  }
  const bare = compact.startsWith(MASK_MARK) ? compact.slice(MASK_MARK.length) : compact;
  return `${MASK_MARK}${bare.slice(-6)}`;
}

/** Só JIDs (`…1234@g.us`). Seguro para ids de mensagem OpenWA: o hash da mensagem fica. */
export function maskJidsInText(text: string): string {
  if (!text) return text;
  return text.replace(JID_RE, (_m, user: string, server: string) => `${MASK_MARK}${user.slice(-4)}@${server}`);
}

/** Máscara completa de PII em texto livre. */
export function maskPii(text: string): string;
export function maskPii(text: string | undefined): string | undefined;
export function maskPii(text: string | undefined): string | undefined {
  if (!text) return text;
  let out = maskJidsInText(text);
  out = out.replace(BRCODE_RE, (m) => maskPixValue(m));
  out = out.replace(E2E_RE, (m) => maskPixValue(m));
  out = out.replace(PIX_RE, (_m, prefix: string, value: string) => `${prefix}${maskPixValue(value)}`);
  for (const re of ACCOUNT_RES) out = out.replace(re, "conta [removida]");
  out = out.replace(AGENCY_RE, "agência [removida]");
  out = out.replace(CPF_FORMATTED_RE, (m) => maskCpfValue(m));
  out = out.replace(CPF_BARE_RE, (m, d: string) => (isValidCpf(d) ? maskCpfValue(d) : m));
  out = out.replace(PHONE_RE, (m) => maskPhoneValue(m));
  return out;
}

/** Aplica `maskPii` só nas chaves de texto livre indicadas (objeto novo). */
export function maskFields<T extends Record<string, unknown>>(obj: T, keys: readonly (keyof T)[]): T {
  let next: T | undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value !== "string") continue;
    const masked = maskPii(value);
    if (masked === value) continue;
    next ??= { ...obj };
    (next as Record<string, unknown>)[key as string] = masked;
  }
  return next ?? obj;
}

/** Id de conversa para log: JID → `…1234@g.us`; outro id numérico → `…1234`. */
export function maskIdForLog(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const jid = maskJidsInText(value);
  if (jid !== value) return jid;
  const d = digits(value);
  if (d.length > 4) return `${MASK_MARK}${d.slice(-4)}`;
  return value.length > 12 ? `${value.slice(0, 4)}${MASK_MARK}` : value;
}
