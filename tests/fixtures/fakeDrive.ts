import { createHash } from "node:crypto";
import { createDriveClient, FOLDER_MIME } from "../../src/drive/googleDrive.ts";

export type FakeFile = { id: string; name: string; mimeType: string; parents: string[]; md5Checksum?: string };

/** Drive v3 em memória, no nível do fetch: só entende GET de lista/arquivo e POST de criar/copiar. */
export function fakeDrive(seed: FakeFile[] = []) {
  const files = new Map<string, FakeFile>(seed.map((f) => [f.id, f]));
  const calls: Array<{ method: string; path: string }> = [];
  let seq = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path: u.pathname });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && u.pathname === "/drive/v3/files") {
      const q = u.searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\'/g, "'");
      const foldersOnly = q.includes(`mimeType = '${FOLDER_MIME}'`);
      const list = [...files.values()].filter((f) => f.parents.includes(parent ?? "") && (name === undefined || f.name === name) && (!foldersOnly || f.mimeType === FOLDER_MIME));
      return json({ files: list });
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (method === "GET" && one) {
      const f = files.get(decodeURIComponent(one[1]!));
      return f ? json(f) : json({ error: { errors: [{ reason: "notFound" }] } }, 404);
    }
    if (method === "POST" && u.pathname === "/drive/v3/files") {
      const meta = JSON.parse(String(init?.body)) as { name: string; mimeType: string; parents: string[] };
      const f: FakeFile = { id: `id${++seq}`, ...meta };
      files.set(f.id, f);
      return json(f);
    }
    if (method === "POST" && u.pathname === "/upload/drive/v3/files") {
      const body = Buffer.from(init?.body as Buffer);
      const text = body.toString("latin1");
      const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/s.exec(text)![1]!) as { name: string; mimeType: string; parents: string[] };
      const boundary = /^--([^\r]+)/.exec(text)![1]!;
      const partStart = text.indexOf("\r\n\r\n", text.indexOf(`--${boundary}`, 3)) + 4;
      const partEnd = text.lastIndexOf(`\r\n--${boundary}--`);
      const data = body.subarray(partStart, partEnd);
      const f: FakeFile = { id: `id${++seq}`, ...meta, md5Checksum: createHash("md5").update(data).digest("hex") };
      files.set(f.id, f);
      return json(f);
    }
    const copy = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(u.pathname);
    if (method === "POST" && copy) {
      const src = files.get(decodeURIComponent(copy[1]!));
      if (!src) return json({ error: { errors: [{ reason: "notFound" }] } }, 404);
      const meta = JSON.parse(String(init?.body)) as { name: string; parents: string[] };
      const f: FakeFile = { ...src, id: `id${++seq}`, ...meta };
      files.set(f.id, f);
      return json(f);
    }
    return json({ error: { errors: [{ reason: "unexpected" }] } }, 400);
  }) as typeof fetch;
  const client = createDriveClient({ token: async () => "tok", fetchImpl });
  return { files, calls, client, fetchImpl };
}

