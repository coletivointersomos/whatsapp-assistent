import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { DRIVE_SCOPE } from "./googleDrive.ts";

/**
 * Upload do Drive em nome de um USUÁRIO (OAuth 2.0, cliente "App para computador"), para usar a cota
 * da conta dona da pasta em vez da conta de serviço (que não tem cota: storageQuotaExceeded).
 *   DRIVE_AUTH=oauth_user
 *   DRIVE_OAUTH_CLIENT_FILE=/run/secrets/drive-oauth/client.json   (JSON baixado do console GCP)
 *   DRIVE_OAUTH_TOKEN_FILE=/run/secrets/drive-oauth/token.json     (refresh token; chmod 600; fora do git)
 * Nada aqui imprime client_secret, código, refresh token ou access token.
 */
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const DEFAULT_REDIRECT = "http://127.0.0.1:8765/";

export type OAuthClient = { clientId: string; clientSecret: string; redirectUris: string[]; kind: "installed" | "web" };
export type StoredToken = { refresh_token: string; scope: string; obtained_at: string; account?: string };
export type PendingAuth = { verifier: string; state: string; redirectUri: string; created_at: string };

export function assertPrivate(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`oauth: ${path} com permissão aberta (${mode.toString(8)}); use chmod 600`);
}

export function readSecretJson<T>(path: string): T {
  assertPrivate(path);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Escreve com 0600 desde a criação (arquivo temporário + rename). */
export function writeSecretJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function loadOAuthClient(path: string): OAuthClient {
  const raw = readSecretJson<Record<string, { client_id?: string; client_secret?: string; redirect_uris?: string[] }>>(path);
  const kind = raw.installed ? "installed" : raw.web ? "web" : undefined;
  const c = kind ? raw[kind] : undefined;
  if (!kind || !c?.client_id || !c.client_secret) throw new Error("oauth: arquivo do cliente sem client_id/client_secret (baixe o JSON do cliente OAuth no console)");
  return { clientId: c.client_id, clientSecret: c.client_secret, redirectUris: c.redirect_uris ?? [], kind };
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function buildAuthUrl(input: { client: Pick<OAuthClient, "clientId">; redirectUri: string; state: string; challenge: string; loginHint?: string }): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", input.client.clientId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", DRIVE_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", input.state);
  u.searchParams.set("code_challenge", input.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (input.loginHint) u.searchParams.set("login_hint", input.loginHint);
  return u.toString();
}

/** Aceita a URL inteira para onde o Google redirecionou (http://127.0.0.1:8765/?state=…&code=…) ou só o código. */
export function parseCodeInput(input: string, expectedState: string): string {
  const text = input.trim();
  if (/^https?:\/\//i.test(text)) {
    const u = new URL(text);
    const error = u.searchParams.get("error");
    if (error) throw new Error(`oauth: autorização recusada (${error})`);
    if (u.searchParams.get("state") !== expectedState) throw new Error("oauth: state não confere — gere a URL de novo");
    const code = u.searchParams.get("code");
    if (!code) throw new Error("oauth: URL sem code");
    return code;
  }
  if (!text) throw new Error("oauth: código vazio");
  return text;
}

async function tokenCall(body: Record<string, string>, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const res = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const raw = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    json = {};
  }
  if (!res.ok) throw new Error(`oauth http ${res.status}${typeof json.error === "string" ? ` ${json.error}` : ""}`);
  return json;
}

export async function exchangeCode(input: { client: OAuthClient; code: string; verifier: string; redirectUri: string; fetchImpl?: typeof fetch }): Promise<{ refreshToken: string; accessToken: string; scope: string }> {
  const json = await tokenCall(
    { grant_type: "authorization_code", code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri, client_id: input.client.clientId, client_secret: input.client.clientSecret },
    input.fetchImpl ?? fetch,
  );
  const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : "";
  const scope = typeof json.scope === "string" ? json.scope : "";
  if (!refreshToken) throw new Error("oauth: sem refresh_token (revogue o acesso em myaccount.google.com/permissions e autorize de novo)");
  if (!scope.split(" ").includes(DRIVE_SCOPE)) throw new Error("oauth: escopo do Drive não concedido (marque a caixa do Drive na tela de consentimento)");
  return { refreshToken, accessToken: String(json.access_token ?? ""), scope };
}

/** Provedor de access token por refresh token; cache em memória (~50 min). */
export function userOAuthTokenProvider(input: { clientFile: string; tokenFile: string; fetchImpl?: typeof fetch }): () => Promise<string> {
  let cached: { token: string; until: number } | undefined;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const client = loadOAuthClient(input.clientFile);
    const stored = readSecretJson<StoredToken>(input.tokenFile);
    if (!stored.refresh_token) throw new Error("oauth: arquivo de token sem refresh_token");
    const json = await tokenCall({ grant_type: "refresh_token", refresh_token: stored.refresh_token, client_id: client.clientId, client_secret: client.clientSecret }, input.fetchImpl ?? fetch);
    const token = typeof json.access_token === "string" ? json.access_token : "";
    if (!token) throw new Error("oauth: resposta sem access_token");
    const ttl = typeof json.expires_in === "number" ? json.expires_in : 3600;
    cached = { token, until: Date.now() + Math.max(60, ttl - 600) * 1000 };
    return token;
  };
}
