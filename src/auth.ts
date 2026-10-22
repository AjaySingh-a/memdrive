import { createHash, randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { BUILTIN_CLIENT_ID, BUILTIN_CLIENT_SECRET } from "./oauth-client";
import { CREDENTIALS_FILE, loadConfig, readJson, writeJson } from "./paths";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
// drive.file only lets memdrive see files it created itself, nothing else in the user's Drive.
const SCOPE = "https://www.googleapis.com/auth/drive.file";

interface Credentials {
  clientId: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}

export function oauthClient(): { id: string; secret: string } {
  const config = loadConfig();
  const id = process.env.MEMDRIVE_CLIENT_ID || config.clientId || BUILTIN_CLIENT_ID;
  const secret = process.env.MEMDRIVE_CLIENT_SECRET || config.clientSecret || BUILTIN_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "no Google OAuth client configured. Run: memdrive connect --client-id <id> --client-secret <secret>\n" +
        "(see docs/google-oauth-setup.md)",
    );
  }
  return { id, secret };
}

export const isConnected = () =>
  !!process.env.MEMDRIVE_ACCESS_TOKEN || existsSync(CREDENTIALS_FILE);

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // the URL is printed too, so the user can open it by hand
  }
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`Google sign-in failed: ${body.error_description || body.error || res.status}`);
  return body;
}

// Installed-app OAuth flow with PKCE and a loopback redirect.
export async function connect(): Promise<void> {
  const client = oauthClient();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/") return new Response("not found", { status: 404 });
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state) return new Response("state mismatch", { status: 400 });
      if (error || !code) {
        rejectCode(new Error(`Google sign-in was not completed (${error || "no code"})`));
        return page("Sign-in cancelled", "memdrive was not connected. You can close this tab.");
      }
      resolveCode(code);
      return page("memdrive is connected", "Your claude-mem backups will go to your Google Drive. You can close this tab.");
    },
  });

  const redirectUri = `http://127.0.0.1:${server.port}/`;
  const authUrl = `${AUTH_URL}?${new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state,
  })}`;

  console.log("Opening your browser to connect Google Drive...");
  console.log(`If it does not open, visit:\n\n  ${authUrl}\n`);
  openBrowser(authUrl);

  const timeout = setTimeout(() => rejectCode(new Error("timed out waiting for Google sign-in")), 5 * 60_000);
  try {
    const code = await codePromise;
    const tokens = await tokenRequest({
      code,
      client_id: client.id,
      client_secret: client.secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    });
    if (!tokens.refresh_token) throw new Error("Google did not return a refresh token");
    const creds: Credentials = {
      clientId: client.id,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
    };
    writeJson(CREDENTIALS_FILE, creds, true);
  } finally {
    clearTimeout(timeout);
    server.stop(true);
  }
}

function page(title: string, text: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>${title}</h1><p>${text}</p></body>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function accessToken(forceRefresh = false): Promise<string> {
  if (process.env.MEMDRIVE_ACCESS_TOKEN) return process.env.MEMDRIVE_ACCESS_TOKEN;
  const creds = readJson<Credentials | null>(CREDENTIALS_FILE, null);
  if (!creds) throw new Error("not connected to Google Drive. Run: memdrive connect");
  if (!forceRefresh && creds.accessToken && (creds.expiresAt ?? 0) > Date.now()) return creds.accessToken;

  const client = oauthClient();
  const tokens = await tokenRequest({
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  });
  creds.accessToken = tokens.access_token;
  creds.expiresAt = Date.now() + (tokens.expires_in - 60) * 1000;
  writeJson(CREDENTIALS_FILE, creds, true);
  return creds.accessToken!;
}

export async function disconnect(): Promise<void> {
  const creds = readJson<Credentials | null>(CREDENTIALS_FILE, null);
  if (creds) {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(creds.refreshToken)}`, { method: "POST" }).catch(() => {});
  }
  rmSync(CREDENTIALS_FILE, { force: true });
}
