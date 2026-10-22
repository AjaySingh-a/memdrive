import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export const HOME_DIR = process.env.MEMDRIVE_HOME || join(homedir(), ".memdrive");
export const CREDENTIALS_FILE = join(HOME_DIR, "credentials.json");
export const CONFIG_FILE = join(HOME_DIR, "config.json");
export const ENCRYPTION_FILE = join(HOME_DIR, "encryption.json");
export const STATE_FILE = join(HOME_DIR, "state.json");
export const LOG_FILE = join(HOME_DIR, "memdrive.log");
export const LOCK_FILE = join(HOME_DIR, "backup.lock");

export interface Config {
  clientId?: string;
  clientSecret?: string;
  machine?: string;
  intervalHours?: number;
  keepDays?: number;
  keepMin?: number;
  autoUpdate?: boolean;
}

export interface State {
  lastSuccessAt?: string;
  lastFingerprint?: string;
  lastFile?: string;
  lastError?: string;
  lastErrorAt?: string;
  lastUpdateCheckAt?: string;
  latestVersion?: string;
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, value: unknown, secret = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: secret ? 0o600 : 0o644 });
  if (secret && process.platform !== "win32") chmodSync(path, 0o600);
}

export const loadConfig = () => readJson<Config>(CONFIG_FILE, {});
export const saveConfig = (c: Config) => writeJson(CONFIG_FILE, c, true);
export const loadState = () => readJson<State>(STATE_FILE, {});
export const saveState = (s: State) => writeJson(STATE_FILE, s);

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

// Same resolution order claude-mem uses: env var, then settings.json, then ~/.claude-mem.
export function claudeMemDataDir(): string {
  if (process.env.CLAUDE_MEM_DATA_DIR) return expandHome(process.env.CLAUDE_MEM_DATA_DIR);
  const fallback = join(homedir(), ".claude-mem");
  const settings = readJson<Record<string, unknown>>(join(fallback, "settings.json"), {});
  const fromSettings = settings.CLAUDE_MEM_DATA_DIR;
  if (typeof fromSettings === "string" && fromSettings) return expandHome(fromSettings);
  return fallback;
}

// Some Macs report a hostname like "Unknown_4e-26-90-c0-dd-d7" or "localhost";
// the user-facing computer name is a better folder name in those cases.
export function looksGenerated(name: string): boolean {
  return !name || /^(unknown|localhost)/i.test(name) || /([0-9a-f]{2}[-:_]){5}[0-9a-f]{2}/i.test(name);
}

function friendlyComputerName(): string {
  if (process.platform === "darwin") {
    try {
      const out = Bun.spawnSync(["scutil", "--get", "ComputerName"]).stdout.toString().trim();
      if (out) return out;
    } catch {}
  }
  if (process.platform === "win32" && process.env.COMPUTERNAME) return process.env.COMPUTERNAME;
  return "";
}

export function sanitizeMachineName(raw: string): string {
  return raw
    .replace(/['’]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The name is saved on the first backup (see backup.ts), so the Drive folder never
// changes even if the computer is renamed later.
export function machineName(): string {
  const saved = loadConfig().machine;
  if (saved) return sanitizeMachineName(saved);
  let name = hostname().split(".")[0];
  if (looksGenerated(name)) name = friendlyComputerName() || name;
  return sanitizeMachineName(name) || "computer";
}

export function ensureHomeDir(): void {
  if (!existsSync(HOME_DIR)) mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
}
