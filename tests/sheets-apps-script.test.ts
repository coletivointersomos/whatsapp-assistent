import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedState } from "../src/config/seed.ts";
import { postAppsScriptRewrite } from "../src/sheets/appsScript.ts";
import { canWriteAppsScript, loadSheetsWriteConfig, sheetsWriteSkipReason } from "../src/sheets/config.ts";
import { writeSessionToSheet } from "../src/sheets/write.ts";
import { SHEET_COLUMNS } from "../src/sheets/mapper.ts";

describe("sheets apps script", () => {
  it("is ready when enabled with web app url and token, without a service account", () => {
    const config = loadSheetsWriteConfig({
      SHEETS_SYNC_ENABLED: "true",
      SHEETS_APPS_SCRIPT_URL: "https://script.google.com/macros/s/abc/exec",
      SHEETS_APPS_SCRIPT_TOKEN: "secret-token",
    });
    assert.equal(canWriteAppsScript(config), true);
    assert.equal(sheetsWriteSkipReason(config), undefined);
  });

  it("blocks when the web app url is set without a token", () => {
    const config = loadSheetsWriteConfig({
      SHEETS_SYNC_ENABLED: "true",
      SHEETS_APPS_SCRIPT_URL: "https://script.google.com/macros/s/abc/exec",
      SHEETS_APPS_SCRIPT_TOKEN: "",
    });
    assert.equal(sheetsWriteSkipReason(config), "missing_apps_script_token");
  });

  it("posts header and rows and follows the Apps Script redirect", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      calls.push(`${init?.method ?? "GET"} ${href}`);
      const body = String(init?.body ?? "");
      assert.match(body, /secret-token/);
      assert.match(body, /record_id/);
      if (href.includes("script.google.com") && init?.redirect === "manual") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://script.googleusercontent.com/macros/echo?n=1" },
        });
      }
      return new Response(JSON.stringify({ ok: true, rowCount: 0 }), { status: 200 });
    }) as typeof fetch;
    const posted = await postAppsScriptRewrite({
      url: "https://script.google.com/macros/s/abc/exec",
      token: "secret-token",
      tabName: "registros",
      values: [ [...SHEET_COLUMNS] ],
      fetchImpl,
    });
    assert.equal(posted.ok, true);
    if (posted.ok) assert.equal(posted.rowCount, 0);
    assert.ok(calls.some((item) => item.includes("script.google.com")));
    assert.ok(calls.some((item) => item.includes("script.googleusercontent.com")));
  });

  it("writes the session through writeSessionToSheet when Apps Script is configured", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: true, rowCount: 0 }), { status: 200 })) as typeof fetch;
    const result = await writeSessionToSheet({
      state: seedState(),
      config: {
        enabled: true,
        credentialsPath: "",
        spreadsheetId: "",
        tabName: "registros",
        appsScriptUrl: "https://script.google.com/macros/s/abc/exec",
        appsScriptToken: "secret-token",
      },
      fetchImpl,
    });
    assert.equal(result.ok, true);
  });
});
