import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { applyChannelConfig } from "../src/adapters/hermes/config.ts";
import type { MessageSender, SendTextInput, SendTextResult } from "../src/adapters/hermes/openwaSend.ts";
import type { ChannelConfig } from "../src/adapters/hermes/types.ts";
import { seedState } from "../src/config/seed.ts";
import { archiveBaseName, archiveToDrive, buildArchiveItems, ensureMonthFolders, monthFolderName, uploadIfNew } from "../src/drive/archive.ts";
import { driveSkipReason, loadDriveConfig, type DriveConfig } from "../src/drive/config.ts";
import { createDriveClient, FOLDER_MIME } from "../src/drive/googleDrive.ts";
import type { RuntimeConfig } from "../src/runtime/config.ts";
import { handleInboundPayload } from "../src/runtime/pipeline.ts";

type FakeFile = { id: string; name: string; mimeType: string; parents: string[]; md5Checksum?: string };

/** Drive v3 em memória, no nível do fetch: só entende GET de lista/arquivo e POST de criar/copiar. */
function fakeDrive(seed: FakeFile[] = []) {
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

const ROOT = "root-folder";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9)]);

describe("2d Drive (só criar)", () => {
  it("flag off by default; needs chats listed", () => {
    const off = loadDriveConfig({});
    assert.equal(off.enabled, false);
    assert.equal(driveSkipReason(off), "drive_disabled");
    assert.equal(off.rootFolderId, "1zu51FqqV0AyVm8NB1Df8U2-thPka9P7m");
    assert.equal(driveSkipReason(loadDriveConfig({ DRIVE_ENABLED: "true", GOOGLE_APPLICATION_CREDENTIALS: "/x.json" })), "drive_chats_empty");
    assert.equal(driveSkipReason(loadDriveConfig({ DRIVE_ENABLED: "true", GOOGLE_APPLICATION_CREDENTIALS: "/x.json", DRIVE_CHAT_IDS: "1@g.us" })), undefined);
  });

  it("names month folders AAAA-MM Mês", () => {
    assert.equal(monthFolderName("2026-10"), "2026-10 Outubro");
    assert.equal(monthFolderName("2026-03"), "2026-03 Março");
    assert.throws(() => monthFolderName("x"));
  });

  it("creates only missing folders, reusing existing ones", async () => {
    const d = fakeDrive([
      { id: "m10", name: "2026-10 Outubro", mimeType: FOLDER_MIME, parents: [ROOT] },
      { id: "m10f", name: "fotos", mimeType: FOLDER_MIME, parents: ["m10"] },
    ]);
    const first = await ensureMonthFolders(d.client, ROOT, "2026-10");
    assert.equal(first.monthId, "m10");
    assert.equal(first.sub.fotos, "m10f");
    assert.deepEqual(first.created, ["2026-10 Outubro/audios", "2026-10 Outubro/transcricoes", "2026-10 Outubro/comprovantes", "2026-10 Outubro/conversa"]);
    const again = await ensureMonthFolders(d.client, ROOT, "2026-10");
    assert.deepEqual(again.created, []);
    const sep = await ensureMonthFolders(d.client, ROOT, "2026-09");
    assert.equal(sep.created[0], "2026-09 Setembro");
    assert.equal(sep.created.length, 6);
  });

  it("never overwrites: same content is reused, same name with other content gets a suffix", async () => {
    const d = fakeDrive([{ id: "f", name: "fotos", mimeType: FOLDER_MIME, parents: [ROOT] }]);
    const a = await uploadIfNew(d.client, "f", { name: "x.jpg", mime: "image/jpeg", data: JPEG });
    assert.equal(a.status, "uploaded");
    const b = await uploadIfNew(d.client, "f", { name: "outro-nome.jpg", mime: "image/jpeg", data: JPEG });
    assert.equal(b.status, "exists");
    assert.equal(b.file.id, a.file.id);
    const c = await uploadIfNew(d.client, "f", { name: "x.jpg", mime: "image/jpeg", data: Buffer.concat([JPEG, Buffer.from([1])]) });
    assert.equal(c.status, "uploaded");
    assert.equal(c.file.name, "x (2).jpg");
    assert.equal([...d.files.values()].filter((f) => f.parents.includes("f")).length, 2);
  });

  it("client refuses anything but GET/POST-create (no PATCH/PUT/DELETE/update)", async () => {
    const d = fakeDrive();
    const methods = d.calls.map((c) => c.method);
    assert.deepEqual(methods, []);
    await ensureMonthFolders(d.client, ROOT, "2026-10");
    await uploadIfNew(d.client, "x", { name: "a.txt", mime: "text/plain", data: Buffer.from("a") });
    assert.ok(d.calls.every((c) => c.method === "GET" || c.method === "POST"));
    assert.ok(d.calls.every((c) => !/\/files\/[^/]+$/.test(c.path) || c.method === "GET"));
  });

  it("builds items: fact month for media, sent month for conversa, transcript .txt, no JID in names", () => {
    const externalId = "false_120363000000007200@g.us_ABCDEF123_5511999990000@lid";
    const items = buildArchiveItems({
      externalId,
      sentAt: "2026-10-05T13:00:00.000Z",
      factCompetencia: "2026-09",
      audio: { mime: "audio/ogg", base64: Buffer.from("OggS....").toString("base64") },
      transcript: "abasteci 200 litros",
      author: "motorista",
    });
    const base = archiveBaseName(externalId, "2026-10-05T13:00:00.000Z");
    assert.match(base, /^2026-10-05 100000-[0-9a-f]{8}$/);
    assert.deepEqual(items.map((i) => [i.folder, i.competencia, i.name]), [
      ["audios", "2026-09", `${base}.ogg`],
      ["transcricoes", "2026-09", `${base}.txt`],
      ["conversa", "2026-10", `conversa-${base}.txt`],
    ]);
    assert.ok(items.every((i) => !/@|7200|0000@/.test(i.name)));
    assert.match(items[1]!.data.toString(), /TRANSCRIÇÃO AUTOMÁTICA/);
    const pdf = buildArchiveItems({ externalId: "e", sentAt: "2026-10-05T13:00:00.000Z", pdf: { mime: "application/pdf", base64: "JVBERg==" }, originalName: "00003078-Comprovante_17-10-2026 141044.pdf" });
    assert.equal(pdf[0]!.folder, "comprovantes");
    assert.equal(pdf[0]!.competencia, "2026-10");
    assert.equal(pdf[0]!.name, "00003078-Comprovante_17-10-2026 141044.pdf");
    const cpf = buildArchiveItems({ externalId: "e", sentAt: "2026-10-05T13:00:00.000Z", text: "meu cpf 529.982.247-25" });
    assert.doesNotMatch(cpf[0]!.data.toString(), /529\.982/);
  });

  it("archiveToDrive puts a photo into AAAA-MM Mês/fotos of the fact month", async () => {
    const d = fakeDrive();
    const items = buildArchiveItems({ externalId: "m1", sentAt: "2026-10-02T12:00:00.000Z", factCompetencia: "2026-09", photo: { mime: "image/jpeg", base64: JPEG.toString("base64") } });
    const res = await archiveToDrive({ client: d.client, rootFolderId: ROOT, items });
    assert.deepEqual(res.map((r) => [r.folder, r.competencia, r.status]), [["fotos", "2026-09", "uploaded"], ["conversa", "2026-10", "uploaded"]]);
    const sep = [...d.files.values()].find((f) => f.name === "2026-09 Setembro")!;
    const fotos = [...d.files.values()].find((f) => f.name === "fotos" && f.parents.includes(sep.id))!;
    assert.ok([...d.files.values()].some((f) => f.parents.includes(fotos.id) && f.mimeType === "image/jpeg"));
    const res2 = await archiveToDrive({ client: d.client, rootFolderId: ROOT, items });
    assert.deepEqual(res2.map((r) => r.status), ["exists", "exists"]);
  });

  it("pipeline: photo from the listed group archived (awaited); unlisted group and flag off do nothing; never sends", async () => {
    const channel: ChannelConfig = { sessionId: "s", adminIds: [], botIds: [], conversations: [{ conversationId: "g@g.us", role: "motorista", driverId: "motorista-joao", driverJids: ["a@c.us"] }] };
    const runtime = { serviceName: "t", liveSend: false, hmacRequired: false, hmacSecret: "", sessionId: "s", testGroupJid: "g@g.us", channel, openwaBaseUrl: "", openwaApiKey: "", openwaApiKeyHeader: "X-Api-Key", openwaSendPath: "/x", openwaMediaPath: "/y", port: 0, storePath: "x", adminAlertJid: "" } as RuntimeConfig;
    const sent: SendTextInput[] = [];
    const sender: MessageSender = { async sendText(i: SendTextInput): Promise<SendTextResult> { sent.push(i); return { ok: true, status: 200 }; } };
    const clock = { now: () => new Date("2026-10-19T12:00:00.000Z"), assistantV2Enabled: false, nluFirst: false, assistantFirst: false, nluEnabled: false };
    const envelope = (id: string) => ({ event: "message.received", sessionId: "s", data: { id, chatId: "g@g.us", author: "a@c.us", isGroup: true, type: "image", body: "", timestamp: 1760000000, media: { mimetype: "image/jpeg", data: JPEG.toString("base64") } } });
    const on: DriveConfig = { enabled: true, rootFolderId: ROOT, credentialsPath: "/x.json", chatIds: ["g@g.us"] };

    const d1 = fakeDrive();
    const logs: string[] = [];
    await handleInboundPayload({ runtime, state: applyChannelConfig(seedState(), channel), sender, clock, envelope: envelope("img-1"), log: (e) => logs.push(e), drive: { config: on, client: d1.client, awaitArchive: true } });
    assert.ok([...d1.files.values()].some((f) => f.mimeType === "image/jpeg"));
    assert.ok(logs.includes("drive_uploaded"));

    const d2 = fakeDrive();
    await handleInboundPayload({ runtime, state: applyChannelConfig(seedState(), channel), sender, clock, envelope: envelope("img-2"), drive: { config: { ...on, chatIds: ["other@g.us"] }, client: d2.client, awaitArchive: true } });
    await handleInboundPayload({ runtime, state: applyChannelConfig(seedState(), channel), sender, clock, envelope: envelope("img-3"), drive: { config: { ...on, enabled: false }, client: d2.client, awaitArchive: true } });
    assert.equal(d2.calls.length, 0);
    assert.equal(sent.length, 0);
  });
});
