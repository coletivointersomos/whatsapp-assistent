import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main as oauthCli } from "../src/cli/driveOauth.ts";
import { driveTokenProvider } from "../src/drive/auth.ts";
import { driveSkipReason, loadDriveConfig } from "../src/drive/config.ts";
import { DRIVE_SCOPE } from "../src/drive/googleDrive.ts";
import { assertPrivate, buildAuthUrl, loadOAuthClient, parseCodeInput, pkcePair, userOAuthTokenProvider, writeSecretJson } from "../src/drive/oauthUser.ts";

const SECRET = "GOCSPX-super-secreto";
const REFRESH = "1//refresh-super-secreto";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "oauth-"));
  const clientFile = join(dir, "client.json");
  const tokenFile = join(dir, "token.json");
  writeFileSync(clientFile, JSON.stringify({ installed: { client_id: "123.apps.googleusercontent.com", client_secret: SECRET, redirect_uris: ["http://localhost"] } }), { mode: 0o600 });
  return { dir, clientFile, tokenFile, env: { DRIVE_AUTH: "oauth_user", DRIVE_OAUTH_CLIENT_FILE: clientFile, DRIVE_OAUTH_TOKEN_FILE: tokenFile, DRIVE_OAUTH_EXPECTED_ACCOUNT: "dona@gmail.com" } };
}

function fakeGoogle(email = "dona@gmail.com", scope = DRIVE_SCOPE) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      const p = new URLSearchParams(String(init?.body));
      if (p.get("grant_type") === "authorization_code") return json({ access_token: "ya29.a", refresh_token: REFRESH, scope, expires_in: 3599 });
      if (p.get("grant_type") === "refresh_token") return p.get("refresh_token") === REFRESH ? json({ access_token: "ya29.b", expires_in: 3599 }) : json({ error: "invalid_grant" }, 400);
    }
    if (String(url).includes("/drive/v3/about")) return json({ user: { emailAddress: email }, storageQuota: { limit: "16106127360", usage: "100" } });
    return json({}, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("Drive por OAuth de usuário (preparado, desligado)", () => {
  it("padrão continua conta de serviço; oauth_user exige os dois arquivos", () => {
    assert.equal(loadDriveConfig({}).auth, "service_account");
    const c = loadDriveConfig({ DRIVE_ENABLED: "true", DRIVE_AUTH: "oauth_user", DRIVE_CHAT_IDS: "1@g.us" });
    assert.equal(driveSkipReason(c), "drive_oauth_files_missing");
    assert.equal(driveSkipReason(loadDriveConfig({ DRIVE_ENABLED: "true", DRIVE_AUTH: "oauth_user", DRIVE_CHAT_IDS: "1@g.us", DRIVE_OAUTH_CLIENT_FILE: "/a", DRIVE_OAUTH_TOKEN_FILE: "/b" })), undefined);
    assert.equal(driveSkipReason(loadDriveConfig({ DRIVE_AUTH: "oauth_user" })), "drive_disabled");
    assert.throws(() => loadDriveConfig({ DRIVE_AUTH: "outra" }), /DRIVE_AUTH/);
  });

  it("URL de autorização: escopo drive, offline, consent, PKCE S256, sem segredo", () => {
    const { challenge } = pkcePair();
    const url = new URL(buildAuthUrl({ client: { clientId: "123.apps" }, redirectUri: "http://127.0.0.1:8765/", state: "st", challenge, loginHint: "dona@gmail.com" }));
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("scope"), DRIVE_SCOPE);
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("login_hint"), "dona@gmail.com");
    assert.ok(!url.toString().includes("secret"));
    assert.equal(parseCodeInput("http://127.0.0.1:8765/?state=st&code=4/abc&scope=x", "st"), "4/abc");
    assert.throws(() => parseCodeInput("http://127.0.0.1:8765/?state=outro&code=4/abc", "st"), /state/);
    assert.throws(() => parseCodeInput("http://127.0.0.1:8765/?error=access_denied", "st"), /recusada/);
  });

  it("arquivos de segredo: 0600 obrigatório", () => {
    const { dir } = setup();
    const f = join(dir, "x.json");
    writeSecretJson(f, { a: 1 });
    assert.equal(statSync(f).mode & 0o777, 0o600);
    chmodSync(f, 0o644);
    assert.throws(() => assertPrivate(f), /chmod 600/);
    const open = join(dir, "c.json");
    writeFileSync(open, JSON.stringify({ installed: { client_id: "a", client_secret: "b" } }), { mode: 0o644 });
    assert.throws(() => loadOAuthClient(open), /chmod 600/);
  });

  it("CLI url → exchange → check: salva refresh token 0600, nunca imprime segredo", async () => {
    const s = setup();
    const g = fakeGoogle();
    const lines: string[] = [];
    const out = (l: Record<string, unknown>) => lines.push(JSON.stringify(l));
    assert.equal(await oauthCli(["url"], { env: s.env, out, fetchImpl: g.fetchImpl }), 0);
    const url = new URL(JSON.parse(lines[0]!).url as string);
    const state = url.searchParams.get("state")!;
    assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:8765/");
    assert.equal(statSync(`${s.tokenFile}.pending.json`).mode & 0o777, 0o600);
    const redirected = `http://127.0.0.1:8765/?state=${state}&code=4/codigo-secreto&scope=${encodeURIComponent(DRIVE_SCOPE)}`;
    assert.equal(await oauthCli(["exchange", "-"], { env: s.env, out, stdin: () => redirected, fetchImpl: g.fetchImpl }), 0);
    assert.equal(statSync(s.tokenFile).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(s.tokenFile, "utf8")).refresh_token, REFRESH);
    assert.ok(!existsSync(`${s.tokenFile}.pending.json`));
    const pkce = new URLSearchParams(g.calls.find((c) => c.body.includes("authorization_code"))!.body);
    assert.ok((pkce.get("code_verifier") ?? "").length >= 43);
    assert.equal(await oauthCli(["check"], { env: s.env, out, fetchImpl: g.fetchImpl }), 0);
    assert.equal(JSON.parse(lines.at(-1)!).conta, "dona@gmail.com");
    const printed = lines.join("\n");
    for (const secret of [SECRET, REFRESH, "4/codigo-secreto", "ya29."]) assert.ok(!printed.includes(secret), `vazou ${secret}`);
  });

  it("conta errada ou sem escopo drive: token não é salvo", async () => {
    const s = setup();
    const lines: string[] = [];
    const out = (l: Record<string, unknown>) => lines.push(JSON.stringify(l));
    const g = fakeGoogle("outra@gmail.com");
    await oauthCli(["url"], { env: s.env, out, fetchImpl: g.fetchImpl });
    const state = new URL(JSON.parse(lines[0]!).url as string).searchParams.get("state")!;
    assert.equal(await oauthCli(["exchange", "-"], { env: s.env, out, stdin: () => `http://127.0.0.1:8765/?state=${state}&code=x`, fetchImpl: g.fetchImpl }), 3);
    assert.ok(!existsSync(s.tokenFile));
    const g2 = fakeGoogle("dona@gmail.com", "https://www.googleapis.com/auth/drive.file");
    await assert.rejects(oauthCli(["exchange", "-"], { env: s.env, out, stdin: () => `http://127.0.0.1:8765/?state=${state}&code=x`, fetchImpl: g2.fetchImpl }), /escopo do Drive/);
    assert.ok(!existsSync(s.tokenFile));
  });

  it("provedor: renova pelo refresh token, cacheia; DRIVE_AUTH escolhe o provedor", async () => {
    const s = setup();
    writeSecretJson(s.tokenFile, { refresh_token: REFRESH, scope: DRIVE_SCOPE, obtained_at: "x" });
    const g = fakeGoogle();
    const p = userOAuthTokenProvider({ clientFile: s.clientFile, tokenFile: s.tokenFile, fetchImpl: g.fetchImpl });
    assert.equal(await p(), "ya29.b");
    assert.equal(await p(), "ya29.b");
    assert.equal(g.calls.length, 1);
    const viaConfig = driveTokenProvider(loadDriveConfig(s.env), g.fetchImpl);
    assert.equal(await viaConfig(), "ya29.b");
    writeSecretJson(s.tokenFile, { refresh_token: "revogado", scope: DRIVE_SCOPE, obtained_at: "x" });
    const bad = userOAuthTokenProvider({ clientFile: s.clientFile, tokenFile: s.tokenFile, fetchImpl: g.fetchImpl });
    await assert.rejects(bad(), (e: Error) => /invalid_grant/.test(e.message) && !e.message.includes("revogado"));
  });
});
