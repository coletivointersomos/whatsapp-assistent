import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AppState, StoredMessage } from "../src/domain/types.ts";
import { archiveBaseName } from "../src/drive/archive.ts";
import { assertConversaAppendOnly, buildConversaRow, cellKey, competenciaFromTitle, loadConversaConfig, planConversa, runConversaFill } from "../src/sheets/conversaSheet.ts";
import type { Grid } from "../src/sheets/appendExisting.ts";

const G = "120363000004684@g.us";
const TAB = { title: "Conversa WhatsApp", sheetId: 1708643190, rowCount: 1000 };
const HEAD = ["DATA", "HORA", "REMETENTE", "TIPO", "CONTEÚDO DA MENSAGEM", "ARQUIVO NO DRIVE (LINK)", "TRANSCRIÇÃO / OBSERVAÇÃO", "TRANSCRIÇÃO NO DRIVE (LINK)"];

function grid(): Grid {
  return [HEAD, ["=DATE(2026,10,19)", "=TIME(9,11,30)", "Amanda Cardoso", "TEXTO", "Bom dia!"], ["=DATE(2026,10,19)", "=TIME(9,11,44)", "Amanda Cardoso", "TEXTO", "Obrigada"]];
}
function msg(p: Partial<StoredMessage> & { id: string; at: string }): StoredMessage {
  return {
    externalId: p.id, conversationId: G, authorId: "5577999990000@c.us", authorRole: "motorista", participantId: "5577999990000@c.us", sentAt: p.at, type: "texto", processedAt: p.at,
    raw: { data: { contact: { pushName: "Manoel" } } }, ...p,
  } as StoredMessage;
}
function state(messages: StoredMessage[], records: unknown[] = []): AppState {
  return { messages, records } as unknown as AppState;
}
const cfg = (env: Record<string, string> = {}) => loadConversaConfig({ CONVERSA_SHEET_ENABLED: "true", MODELO_AUTO_FILL_CHAT_IDS: G, ...env });

describe("aba Conversa WhatsApp (existente, só acrescentar)", () => {
  it("linha no formato das manuais, em Brasília, sem máscara, safeText contra fórmula", () => {
    const m = msg({ id: "a", at: "2026-10-19T15:04:05Z", text: "Pix chave CPF 123.456.789-06 =SOMA(1)" });
    const row = buildConversaRow(state([m]), m, cfg().names);
    assert.deepEqual(row.values.slice(0, 5), ["=DATE(2026,10,19)", "=TIME(12,4,5)", "Manoel", "TEXTO", "Pix chave CPF 123.456.789-06 =SOMA(1)"]);
    const f = buildConversaRow(state([m]), { ...m, text: "=HACK()" }, cfg().names);
    assert.equal(f.values[4], "'=HACK()");
  });

  it("remetente: mapa por JID > pushName > [A CONFIRMAR]", () => {
    const m = msg({ id: "a", at: "2026-10-19T15:00:00Z", text: "oi" });
    assert.equal(buildConversaRow(state([m]), m, cfg({ CONVERSA_REMETENTES: "5577999990000@c.us=Manoel Andrade" }).names).values[2], "Manoel Andrade");
    assert.equal(buildConversaRow(state([m]), { ...m, raw: {} }, cfg().names).values[2], "[A CONFIRMAR]");
  });

  it("escreve depois da última linha, só msgs após o corte, dedup pela aba e pelo registro", () => {
    const old = msg({ id: "old", at: "2026-10-19T12:11:44Z", text: "Obrigada", raw: { data: { contact: { pushName: "Amanda Cardoso" } } } });
    const n1 = msg({ id: "n1", at: "2026-10-19T15:00:00Z", text: "Bom dia" });
    const other = { ...msg({ id: "x", at: "2026-10-19T15:00:01Z", text: "outro grupo" }), conversationId: "1@g.us" };
    const bot = { ...msg({ id: "b", at: "2026-10-19T15:00:02Z", text: "bot" }), authorRole: "bot" } as StoredMessage;
    const reg = {};
    const plan = planConversa({ state: state([old, n1, other, bot]), grid: grid(), tab: TAB, competencia: "2026-10", config: cfg(), registry: reg });
    assert.deepEqual(plan.rows.map((r) => [r.linha, r.externalId]), [[4, "n1"]]);
    assert.ok(plan.writes.every((w) => /!([A-H])4$/.test(w.range)));
    const again = planConversa({ state: state([old, n1]), grid: grid(), tab: TAB, competencia: "2026-10", config: cfg(), registry: reg });
    assert.equal(again.writes.length, 0);
    // já na aba (mesma data/hora/remetente/tipo, digitada à mão) → não duplica
    const g = grid();
    g.push(["=DATE(2026,10,19)", "=TIME(12,0,0)", "Manoel", "TEXTO", "Bom dia"]);
    const dup = planConversa({ state: state([n1]), grid: g, tab: TAB, competencia: "2026-10", config: cfg(), registry: {} });
    assert.equal(dup.writes.length, 0);
    assert.equal(dup.skipped[0]!.motivo, "ja_na_aba");
  });

  it("link no Drive: na hora se já subiu; senão pendente e 2º passo só em célula vazia", () => {
    const foto = msg({ id: "f1", at: "2026-10-19T15:10:00Z", type: "anexo_comprovante", raw: { data: { contact: { pushName: "Manoel" }, media: { mimetype: "image/jpeg" } } } });
    const name = `${archiveBaseName("f1", foto.sentAt)}.jpg`;
    const reg: Record<string, never> = {};
    const p1 = planConversa({ state: state([foto]), grid: grid(), tab: TAB, competencia: "2026-10", config: cfg(), registry: reg, files: new Map() });
    assert.equal(p1.rows[0]!.valores[5], "");
    assert.ok((reg as Record<string, { pendingF?: unknown }>).f1!.pendingF);
    const g = grid();
    g.push(p1.rows[0]!.valores.map(String));
    const files = new Map([[`fotos/${name}`, { id: "ID", name, mimeType: "image/jpeg", webViewLink: "https://drive.google.com/file/d/ID/view" }]]);
    const p2 = planConversa({ state: state([foto]), grid: g, tab: TAB, competencia: "2026-10", config: cfg(), registry: reg, files });
    assert.deepEqual(p2.links, [{ celula: "F4", arquivo: name }]);
    assert.match(String(p2.writes[0]!.values[0]![0]), /^=HYPERLINK\("https:\/\/drive.google.com\/file\/d\/ID\/view","/);
    // alguém preencheu F à mão → não sobrescreve
    const g3 = grid();
    g3.push([...p1.rows[0]!.valores.map(String)]);
    g3[3]![5] = "manual";
    const reg3 = { f1: { row: 4, key: "2026-10-19|121000|MANOEL|FOTO", pendingF: { folder: "fotos", name } } };
    assert.equal(planConversa({ state: state([foto]), grid: g3, tab: TAB, competencia: "2026-10", config: cfg(), registry: reg3, files }).writes.length, 0);
  });

  it("áudio: G = transcrição e H = link do .txt em transcricoes", () => {
    const a = msg({ id: "a1", at: "2026-10-19T15:20:00Z", type: "audio_info", text: "chegando em LEM", raw: { data: { contact: { pushName: "Manoel" }, media: { mimetype: "audio/ogg" } } } });
    const base = archiveBaseName("a1", a.sentAt);
    const files = new Map([
      [`audios/${base}.ogg`, { id: "A", name: `${base}.ogg`, mimeType: "audio/ogg" }],
      [`transcricoes/${base}.txt`, { id: "T", name: `${base}.txt`, mimeType: "text/plain" }],
    ]);
    const p = planConversa({ state: state([a]), grid: grid(), tab: TAB, competencia: "2026-10", config: cfg(), registry: {}, files });
    const v = p.rows[0]!.valores;
    assert.equal(v[3], "ÁUDIO");
    assert.equal(v[6], "TRANSCRIÇÃO AUTOMÁTICA (pode conter erros): chegando em LEM");
    assert.match(v[5]!, /file\/d\/A\/view/);
    assert.match(v[7]!, /file\/d\/T\/view/);
  });

  it("travas: célula ocupada, cabeçalho, outra aba, cabeçalho mudado", () => {
    assert.throws(() => assertConversaAppendOnly(grid(), TAB.title, [{ range: "'Conversa WhatsApp'!E3", values: [["x"]] }]), /não está vazia/);
    assert.throws(() => assertConversaAppendOnly(grid(), TAB.title, [{ range: "'Conversa WhatsApp'!A1", values: [["x"]] }]), /cabeçalho/);
    assert.throws(() => assertConversaAppendOnly(grid(), TAB.title, [{ range: "'MANOEL '!A80", values: [["x"]] }]), /fora da aba/);
    const g = grid();
    g[0] = [...HEAD.slice(0, 7), "OUTRA"];
    assert.throws(() => planConversa({ state: state([]), grid: g, tab: TAB, competencia: "2026-10", config: cfg(), registry: {} }), /cabeçalho H1/);
    assert.equal(cellKey("46314", "0.5"), "2026-10-19|120000");
    assert.equal(competenciaFromTitle("TFA - Outubro 2026"), "2026-10");
  });

  it("run: não cria aba, recusa Setembro/Modelo, desligado não chama, dry-run não escreve", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cv-"));
    const mk = (title: string, tabs = [TAB]) => {
      const writes: unknown[] = [];
      return { writes, api: { getMeta: async () => ({ title, sheets: tabs.map((t) => ({ ...t, columnCount: 26 })) }), readGrid: async () => grid(), writeValues: async (_: string, d: unknown[]) => void writes.push(...d) } };
    };
    const st = state([msg({ id: "n1", at: "2026-10-19T15:00:00Z", text: "oi" })]);
    const config = cfg({ CONVERSA_REGISTRY_PATH: join(dir, "r.json") });
    for (const t of ["TFA - Setembro 2026", "Modelo"]) await assert.rejects(runConversaFill({ state: st, spreadsheetId: "s", config, sheets: mk(t).api, rootFolderId: "r" }), /protegida/);
    await assert.rejects(runConversaFill({ state: st, spreadsheetId: "s", config, sheets: mk("TFA - Outubro 2026", [{ ...TAB, title: "Outra" }]).api, rootFolderId: "r" }), /não existe — nada criado/);
    assert.equal((await runConversaFill({ state: st, spreadsheetId: "s", config: { ...config, enabled: false }, sheets: mk("x").api, rootFolderId: "r" })).status, "disabled");
    const dry = mk("TFA - Outubro 2026");
    const d = await runConversaFill({ state: st, spreadsheetId: "s", config, sheets: dry.api, rootFolderId: "r", dryRun: true });
    assert.equal(d.plan!.rows.length, 1);
    assert.equal(dry.writes.length, 0);
    const live = mk("TFA - Outubro 2026");
    await runConversaFill({ state: st, spreadsheetId: "s", config, sheets: live.api, rootFolderId: "r" });
    assert.equal(live.writes.length, 5);
    const live2 = mk("TFA - Outubro 2026");
    await runConversaFill({ state: st, spreadsheetId: "s", config, sheets: live2.api, rootFolderId: "r" });
    assert.equal(live2.writes.length, 0); // registro local evita repetir
  });
});
