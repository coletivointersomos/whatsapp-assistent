import { readFileSync } from "node:fs";
import { fetchGoogleAccessToken, type ServiceAccountFile } from "../sheets/googleJwt.ts";

/**
 * Cliente mínimo do Drive v3. SÓ CRIA: os únicos métodos HTTP permitidos são GET (listar/ler
 * metadados) e POST (criar pasta, subir arquivo, copiar arquivo). Não há PATCH/PUT/DELETE aqui —
 * nada é apagado, movido, renomeado ou sobrescrito. A trava está em `driveRequest`.
 */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  webViewLink?: string;
};

export type DriveClient = {
  listChildren(parentId: string, opts?: { name?: string; foldersOnly?: boolean }): Promise<DriveFile[]>;
  getFile(fileId: string): Promise<DriveFile>;
  createFolder(parentId: string, name: string): Promise<DriveFile>;
  uploadFile(parentId: string, name: string, mime: string, data: Buffer): Promise<DriveFile>;
  copyFile(fileId: string, parentId: string, name: string): Promise<DriveFile>;
};

const FIELDS = "id,name,mimeType,md5Checksum,webViewLink";
const ALLOWED_METHODS = new Set(["GET", "POST"]);

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function q(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function createDriveClient(input: {
  token: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): DriveClient {
  const fetchImpl = input.fetchImpl ?? fetch;

  async function driveRequest<T>(method: string, url: string, init: { body?: BodyInit; contentType?: string } = {}): Promise<T> {
    if (!ALLOWED_METHODS.has(method)) throw new DriveError(`drive method ${method} not allowed (create-only)`, 0);
    if (!url.startsWith(API) && !url.startsWith(UPLOAD)) throw new DriveError("drive url not allowed", 0);
    if (method === "POST" && /\/files\/[^/?]+(\?|$)/.test(url.replace(UPLOAD, API))) {
      // POST em /files/<id> (sem /copy) seria alteração de arquivo existente
      throw new DriveError("drive update not allowed (create-only)", 0);
    }
    const headers: Record<string, string> = { authorization: `Bearer ${await input.token()}` };
    if (init.contentType) headers["content-type"] = init.contentType;
    const response = await fetchImpl(url, { method, headers, body: init.body });
    const raw = await response.text();
    if (!response.ok) {
      let reason = "";
      try {
        const parsed = JSON.parse(raw) as { error?: { errors?: Array<{ reason?: string }>; status?: string } };
        reason = parsed.error?.errors?.[0]?.reason ?? parsed.error?.status ?? "";
      } catch {
        reason = "";
      }
      throw new DriveError(`drive http ${response.status}${reason ? ` ${reason}` : ""}`, response.status);
    }
    return JSON.parse(raw || "{}") as T;
  }

  const common = "supportsAllDrives=true";

  return {
    async listChildren(parentId, opts = {}) {
      const clauses = [`'${q(parentId)}' in parents`, "trashed = false"];
      if (opts.name !== undefined) clauses.push(`name = '${q(opts.name)}'`);
      if (opts.foldersOnly) clauses.push(`mimeType = '${FOLDER_MIME}'`);
      const files: DriveFile[] = [];
      let pageToken = "";
      for (let page = 0; page < 20; page += 1) {
        const url = `${API}/files?q=${encodeURIComponent(clauses.join(" and "))}&fields=${encodeURIComponent(`nextPageToken,files(${FIELDS})`)}&pageSize=200&includeItemsFromAllDrives=true&${common}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
        const res = await driveRequest<{ files?: DriveFile[]; nextPageToken?: string }>("GET", url);
        files.push(...(res.files ?? []));
        if (!res.nextPageToken) break;
        pageToken = res.nextPageToken;
      }
      return files;
    },
    async getFile(fileId) {
      return driveRequest<DriveFile>("GET", `${API}/files/${encodeURIComponent(fileId)}?fields=${FIELDS}&${common}`);
    },
    async createFolder(parentId, name) {
      return driveRequest<DriveFile>("POST", `${API}/files?fields=${FIELDS}&${common}`, {
        contentType: "application/json",
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      });
    },
    async uploadFile(parentId, name, mime, data) {
      const boundary = `hermes${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const meta = JSON.stringify({ name, parents: [parentId], mimeType: mime });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      return driveRequest<DriveFile>("POST", `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}&${common}`, {
        contentType: `multipart/related; boundary=${boundary}`,
        body,
      });
    },
    async copyFile(fileId, parentId, name) {
      return driveRequest<DriveFile>("POST", `${API}/files/${encodeURIComponent(fileId)}/copy?fields=${FIELDS}&${common}`, {
        contentType: "application/json",
        body: JSON.stringify({ name, parents: [parentId] }),
      });
    },
  };
}

/** Token da conta de serviço (mesma das planilhas) com escopo do Drive; cache de 50 min. */
export function serviceAccountTokenProvider(credentialsPath: string, fetchImpl: typeof fetch = fetch): () => Promise<string> {
  let cached: { token: string; until: number } | undefined;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const account = JSON.parse(readFileSync(credentialsPath, "utf8")) as ServiceAccountFile;
    const token = await fetchGoogleAccessToken(account, fetchImpl, DRIVE_SCOPE);
    cached = { token, until: Date.now() + 50 * 60_000 };
    return token;
  };
}
