/**
 * Cole este arquivo no Apps Script da planilha (Extensões → Apps Script).
 * 1. Cole o MESMO token em SYNC_TOKEN e em SHEETS_APPS_SCRIPT_TOKEN no .env do robô.
 * 2. Implantar → Implantação nova → Tipo: aplicativo da Web
 *    - Executar como: eu
 *    - Quem tem acesso: Qualquer pessoa
 * 3. Copiar a URL /exec para SHEETS_APPS_SCRIPT_URL.
 * 4. SHEETS_SYNC_ENABLED=true no transportadora.
 *
 * O robô manda um rewrite da aba (header + linhas). Sem service account.
 */
const SYNC_TOKEN = "SUBSTITUA_PELO_MESMO_TOKEN_DO_ENV";
const DEFAULT_TAB = "registros";

function doGet() {
  return json_({ ok: true, service: "hermes-registros-sync" });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : "";
    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      return json_({ ok: false, reason: "invalid_json" });
    }
    if (!body || body.token !== SYNC_TOKEN) {
      return json_({ ok: false, reason: "unauthorized" });
    }
    const tabName = String(body.tabName || DEFAULT_TAB);
    const values = Array.isArray(body.values) ? body.values : [];
    if (!values.length || !Array.isArray(values[0])) {
      return json_({ ok: false, reason: "missing_values" });
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(tabName);
    if (!sheet) sheet = ss.insertSheet(tabName);
    sheet.clearContents();
    const rows = values.length;
    const cols = values[0].length;
    sheet.getRange(1, 1, rows, cols).setValues(values);
    return json_({ ok: true, rowCount: Math.max(0, rows - 1), tabName: tabName });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
