import { createHash } from "node:crypto";
import { maskPii } from "../privacy/pii.ts";
import type { DriveClient, DriveFile } from "./googleDrive.ts";
import { FOLDER_MIME } from "./googleDrive.ts";

/**
 * Parte 2d: mídias da conversa autorizada → Drive, em
 *   <raiz>/AAAA-MM Mês/{fotos,audios,transcricoes,comprovantes,conversa}
 * Regras (SKILL §6): só acrescentar — cria pasta que falta e sobe arquivo que ainda não existe
 * (conferido por md5Checksum na pasta de destino). Nome igual com conteúdo diferente ganha
 * sufixo " (2)", " (3)"… — nunca sobrescreve. Mídia vai para o mês do FATO; conversa, para o
 * mês de ENVIO.
 */
export const MONTH_SUBFOLDERS = ["fotos", "audios", "transcricoes", "comprovantes", "conversa"] as const;
export type MonthSubfolder = (typeof MONTH_SUBFOLDERS)[number];

const MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

export function monthFolderName(competencia: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(competencia);
  if (!match) throw new Error("competencia invalida");
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) throw new Error("competencia invalida");
  return `${match[1]}-${match[2]} ${month}`;
}

export type ArchiveItem = {
  folder: MonthSubfolder;
  /** AAAA-MM do mês da pasta. */
  competencia: string;
  name: string;
  mime: string;
  data: Buffer;
};

export type ArchiveResult = {
  folder: MonthSubfolder;
  competencia: string;
  status: "uploaded" | "exists";
  file: DriveFile;
};

/** Data/hora em Brasília (UTC-3, sem horário de verão). */
export function brtParts(iso: string): { date: string; time: string } {
  const ms = Date.parse(iso);
  const d = new Date((Number.isFinite(ms) ? ms : Date.now()) - 3 * 3600_000).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 19).replace(/:/g, "") };
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

export function extFor(mime: string): string {
  return EXT[mime.split(";", 1)[0]!.trim().toLowerCase()] ?? "bin";
}

/** Nome-base estável e sem PII: data/hora de envio + 8 hex do hash do id da mensagem (o id tem JID). */
export function archiveBaseName(externalId: string, sentAt: string): string {
  const { date, time } = brtParts(sentAt);
  const tag = createHash("sha256").update(externalId).digest("hex").slice(0, 8);
  return `${date} ${time}-${tag}`;
}

/** Nome original (se o WhatsApp mandou) sem barra, sem controle e com PII mascarada. */
export function safeOriginalName(name: string | undefined): string | undefined {
  const clean = maskPii((name ?? "").replace(/[\\/\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, 120);
  return clean || undefined;
}

export function buildArchiveItems(input: {
  externalId: string;
  sentAt: string;
  /** AAAA-MM do fato (registro); sem fato, mês do envio. */
  factCompetencia?: string;
  photo?: { mime: string; base64: string };
  pdf?: { mime: string; base64: string };
  audio?: { mime: string; base64: string };
  /** Transcrição já mascarada (pii.ts). */
  transcript?: string;
  /** Texto da mensagem (mascarado aqui). */
  text?: string;
  author?: string;
  originalName?: string;
}): ArchiveItem[] {
  const sentComp = brtParts(input.sentAt).date.slice(0, 7);
  const fact = input.factCompetencia && /^\d{4}-\d{2}$/.test(input.factCompetencia) ? input.factCompetencia : sentComp;
  const base = archiveBaseName(input.externalId, input.sentAt);
  const original = safeOriginalName(input.originalName);
  const named = (mime: string) => {
    const ext = extFor(mime);
    if (original) return /\.[A-Za-z0-9]{2,4}$/.test(original) ? original : `${original}.${ext}`;
    return `${base}.${ext}`;
  };
  const items: ArchiveItem[] = [];
  if (input.photo) items.push({ folder: "fotos", competencia: fact, name: named(input.photo.mime), mime: input.photo.mime, data: Buffer.from(input.photo.base64, "base64") });
  if (input.pdf) items.push({ folder: "comprovantes", competencia: fact, name: named(input.pdf.mime), mime: "application/pdf", data: Buffer.from(input.pdf.base64, "base64") });
  if (input.audio) {
    const audioName = named(input.audio.mime);
    items.push({ folder: "audios", competencia: fact, name: audioName, mime: input.audio.mime, data: Buffer.from(input.audio.base64, "base64") });
    if (input.transcript?.trim()) {
      const txt = `${audioName.replace(/\.[A-Za-z0-9]{2,4}$/, "")}.txt`;
      const body = `TRANSCRIÇÃO AUTOMÁTICA (pode conter erros)\n${input.transcript.trim()}\n`;
      items.push({ folder: "transcricoes", competencia: fact, name: txt, mime: "text/plain", data: Buffer.from(body, "utf8") });
    }
  }
  const text = maskPii(input.text ?? "").trim();
  if (text || items.length) {
    const { date, time } = brtParts(input.sentAt);
    const kind = input.photo ? "FOTO" : input.pdf ? "PDF" : input.audio ? "ÁUDIO" : "TEXTO";
    const line = `${date} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)} | ${maskPii(input.author ?? "") || "—"} | ${kind} | ${text || "(sem texto)"}${items.length ? ` | arquivo: ${items[0]!.folder}/${items[0]!.name}` : ""}\n`;
    items.push({ folder: "conversa", competencia: sentComp, name: `conversa-${base}.txt`, mime: "text/plain", data: Buffer.from(line, "utf8") });
  }
  return items;
}

function md5(data: Buffer): string {
  return createHash("md5").update(data).digest("hex");
}

/** Primeira pasta com esse nome (se houver mais de uma, usa a primeira; não mexe nas outras). */
async function ensureFolder(client: DriveClient, parentId: string, name: string): Promise<{ id: string; created: boolean }> {
  const found = (await client.listChildren(parentId, { name, foldersOnly: true })).filter((f) => f.mimeType === FOLDER_MIME);
  if (found[0]) return { id: found[0].id, created: false };
  const made = await client.createFolder(parentId, name);
  return { id: made.id, created: true };
}

export async function ensureMonthFolders(
  client: DriveClient,
  rootFolderId: string,
  competencia: string,
): Promise<{ monthId: string; sub: Record<MonthSubfolder, string>; created: string[] }> {
  const created: string[] = [];
  const monthName = monthFolderName(competencia);
  const month = await ensureFolder(client, rootFolderId, monthName);
  if (month.created) created.push(monthName);
  const existing = (await client.listChildren(month.id, { foldersOnly: true })).filter((f) => f.mimeType === FOLDER_MIME);
  const sub = {} as Record<MonthSubfolder, string>;
  for (const name of MONTH_SUBFOLDERS) {
    const hit = existing.find((f) => f.name === name);
    if (hit) {
      sub[name] = hit.id;
      continue;
    }
    const made = await client.createFolder(month.id, name);
    sub[name] = made.id;
    created.push(`${monthName}/${name}`);
  }
  return { monthId: month.id, sub, created };
}

/** Sobe só se não houver arquivo com o mesmo MD5 na pasta; nome repetido → sufixo, nunca sobrescreve. */
export async function uploadIfNew(client: DriveClient, folderId: string, item: Pick<ArchiveItem, "name" | "mime" | "data">): Promise<{ status: "uploaded" | "exists"; file: DriveFile }> {
  const sum = md5(item.data);
  const children = await client.listChildren(folderId);
  const same = children.find((f) => f.md5Checksum === sum);
  if (same) return { status: "exists", file: same };
  const names = new Set(children.map((f) => f.name));
  let name = item.name;
  const dot = item.name.lastIndexOf(".");
  const stem = dot > 0 ? item.name.slice(0, dot) : item.name;
  const ext = dot > 0 ? item.name.slice(dot) : "";
  for (let n = 2; names.has(name); n += 1) name = `${stem} (${n})${ext}`;
  const file = await client.uploadFile(folderId, name, item.mime, item.data);
  return { status: "uploaded", file };
}

let queue: Promise<unknown> = Promise.resolve();

/** Serializa o arquivamento (evita duas pastas de mês criadas ao mesmo tempo). */
export function archiveToDrive(input: {
  client: DriveClient;
  rootFolderId: string;
  items: ArchiveItem[];
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<ArchiveResult[]> {
  const log = input.log ?? (() => undefined);
  const run = async (): Promise<ArchiveResult[]> => {
    const results: ArchiveResult[] = [];
    const months = new Map<string, Awaited<ReturnType<typeof ensureMonthFolders>>>();
    for (const item of input.items) {
      let month = months.get(item.competencia);
      if (!month) {
        month = await ensureMonthFolders(input.client, input.rootFolderId, item.competencia);
        months.set(item.competencia, month);
        if (month.created.length) log("drive_folders_created", { folders: month.created });
      }
      const res = await uploadIfNew(input.client, month.sub[item.folder], item);
      results.push({ folder: item.folder, competencia: item.competencia, ...res });
      log(res.status === "uploaded" ? "drive_uploaded" : "drive_exists", {
        folder: `${monthFolderName(item.competencia)}/${item.folder}`,
        bytes: item.data.length,
      });
    }
    return results;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
