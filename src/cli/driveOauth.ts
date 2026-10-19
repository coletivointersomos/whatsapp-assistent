import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadDriveConfig } from "../drive/config.ts";
import {
  buildAuthUrl,
  DEFAULT_REDIRECT,
  exchangeCode,
  loadOAuthClient,
  parseCodeInput,
  pkcePair,
  readSecretJson,
  userOAuthTokenProvider,
  writeSecretJson,
  type PendingAuth,
  type StoredToken,
} from "../drive/oauthUser.ts";

/**
 * Login do Google para o Drive do Hermes (OAuth de usuário). Não liga nada: só gera/guarda o token.
 *   tsx src/cli/driveOauth.ts url [--login-hint email] [--redirect http://127.0.0.1:8765/]
 *   tsx src/cli/driveOauth.ts exchange -        (cola a URL do navegador no stdin)
 *   tsx src/cli/driveOauth.ts check             (renova o token e mostra conta + cota; não sobe nada)
 * Arquivos: DRIVE_OAUTH_CLIENT_FILE e DRIVE_OAUTH_TOKEN_FILE (chmod 600, fora do git). Nunca imprime segredos.
 */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

type Out = (line: Record<string, unknown>) => void;

async function about(token: string, fetchImpl: typeof fetch): Promise<{ email: string; usage?: string; limit?: string }> {
  const res = await fetchImpl("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota(limit,usage)", { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`drive about http ${res.status}`);
  const j = (await res.json()) as { user?: { emailAddress?: string }; storageQuota?: { limit?: string; usage?: string } };
  return { email: j.user?.emailAddress ?? "", usage: j.storageQuota?.usage, limit: j.storageQuota?.limit };
}

export async function main(args: string[], io: { env?: Record<string, string | undefined>; stdin?: () => string; out?: Out; fetchImpl?: typeof fetch } = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out: Out = io.out ?? ((l) => process.stdout.write(`${JSON.stringify(l)}\n`));
  const fetchImpl = io.fetchImpl ?? fetch;
  const config = loadDriveConfig(env);
  const clientFile = config.oauthClientFile ?? "";
  const tokenFile = config.oauthTokenFile ?? "";
  if (!clientFile || !tokenFile) {
    out({ status: "erro", motivo: "defina DRIVE_OAUTH_CLIENT_FILE e DRIVE_OAUTH_TOKEN_FILE" });
    return 2;
  }
  const pendingFile = `${tokenFile}.pending.json`;
  const expected = env.DRIVE_OAUTH_EXPECTED_ACCOUNT?.trim().toLowerCase();
  const cmd = args[0];

  if (cmd === "url") {
    const client = loadOAuthClient(clientFile);
    const redirectUri = flag(args, "--redirect") ?? (client.redirectUris.find((u) => u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost")) ? DEFAULT_REDIRECT : client.redirectUris[0] ?? DEFAULT_REDIRECT);
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString("hex");
    writeSecretJson(pendingFile, { verifier, state, redirectUri, created_at: new Date().toISOString() } satisfies PendingAuth);
    out({ status: "ok", tipoCliente: client.kind, redirect: redirectUri, url: buildAuthUrl({ client, redirectUri, state, challenge, loginHint: flag(args, "--login-hint") ?? expected }) });
    return 0;
  }

  if (cmd === "exchange") {
    if (!existsSync(pendingFile)) {
      out({ status: "erro", motivo: "rode 'url' antes" });
      return 2;
    }
    const pending = readSecretJson<PendingAuth>(pendingFile);
    const raw = args[1] === "-" || args[1] === undefined ? (io.stdin ?? (() => readFileSync(0, "utf8")))() : args[1];
    const code = parseCodeInput(raw, pending.state);
    const client = loadOAuthClient(clientFile);
    const got = await exchangeCode({ client, code, verifier: pending.verifier, redirectUri: pending.redirectUri, fetchImpl });
    const who = await about(got.accessToken, fetchImpl);
    if (expected && who.email.toLowerCase() !== expected) {
      out({ status: "erro", motivo: `autorizado com ${who.email}, esperado ${expected} — token NÃO salvo` });
      return 3;
    }
    writeSecretJson(tokenFile, { refresh_token: got.refreshToken, scope: got.scope, obtained_at: new Date().toISOString(), account: who.email } satisfies StoredToken);
    unlinkSync(pendingFile);
    out({ status: "ok", conta: who.email, escopo: got.scope, tokenSalvoEm: tokenFile });
    return 0;
  }

  if (cmd === "check") {
    const token = await userOAuthTokenProvider({ clientFile, tokenFile, fetchImpl })();
    const who = await about(token, fetchImpl);
    const stored = readSecretJson<StoredToken>(tokenFile);
    out({ status: who.email && (!expected || who.email.toLowerCase() === expected) ? "ok" : "conta_diferente", conta: who.email, usoBytes: who.usage, limiteBytes: who.limit, desde: stored.obtained_at });
    return 0;
  }

  out({ status: "erro", motivo: "uso: url | exchange - | check" });
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`erro: ${error instanceof Error ? error.message : "desconhecido"}\n`);
      process.exit(1);
    },
  );
}
