import { mkdtempSync, rmSync, statSync, writeFileSync, openSync, closeSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchive } from "./archive";
import { accessToken } from "./auth";
import { ROOT_FOLDER, deleteFile, ensureFolder, listBackups, uploadFile } from "./drive";
import { log } from "./log";
import {
  LOCK_FILE,
  claudeMemDataDir,
  ensureHomeDir,
  loadConfig,
  loadState,
  machineName,
  saveState,
} from "./paths";
import { fingerprint, snapshot } from "./snapshot";
import pkg from "../package.json";

export const DEFAULTS = { intervalHours: 6, keepDays: 30, keepMin: 5 };

function takeLock(): boolean {
  ensureHomeDir();
  try {
    closeSync(openSync(LOCK_FILE, "wx"));
    writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch {
    // A lock left behind by a crashed run is stale after its pid is gone or after 2 hours.
    try {
      const pid = Number(readFileSync(LOCK_FILE, "utf8"));
      const age = Date.now() - statSync(LOCK_FILE).mtimeMs;
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {}
      if (!alive || age > 2 * 3600_000) {
        writeFileSync(LOCK_FILE, String(process.pid));
        return true;
      }
    } catch {}
    return false;
  }
}

export async function backup(opts: { ifDue?: boolean } = {}): Promise<void> {
  const config = { ...DEFAULTS, ...loadConfig() };
  const state = loadState();
  const dataDir = claudeMemDataDir();
  const machine = machineName();

  if (opts.ifDue) {
    const last = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : 0;
    if (Date.now() - last < config.intervalHours * 3600_000) return;
    if (state.lastFingerprint && state.lastFingerprint === fingerprint(dataDir)) return;
  }
  if (!takeLock()) {
    log("another backup is already running, skipping");
    return;
  }

  const stage = mkdtempSync(join(tmpdir(), "memdrive-"));
  try {
    await accessToken(); // fail fast if Drive is not connected
    const print = fingerprint(dataDir);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const stats = snapshot(dataDir, join(stage, "claude-mem"));
    writeFileSync(
      join(stage, "claude-mem", "memdrive-info.json"),
      JSON.stringify({ machine, created: new Date().toISOString(), memdrive: pkg.version, platform: process.platform }, null, 2),
    );
    const name = `claude-mem-${machine}-${stamp}.tar.gz`;
    const archive = join(stage, name);
    await createArchive(archive, stage, "claude-mem");
    const mb = (statSync(archive).size / 1024 / 1024).toFixed(1);
    log(`snapshot ready: ${stats.databases.length} databases, ${stats.files} files, ${mb} MB`);

    const root = await ensureFolder(ROOT_FOLDER);
    const folder = await ensureFolder(machine, root);
    await uploadFile(archive, name, folder);
    log(`uploaded ${name} to Google Drive / ${ROOT_FOLDER} / ${machine}`);

    // Retention: always keep the newest keepMin backups, delete older ones past keepDays.
    const cutoff = Date.now() - config.keepDays * 86400_000;
    const backups = await listBackups(folder);
    for (const old of backups.slice(config.keepMin)) {
      if (Date.parse(old.createdTime) < cutoff) {
        await deleteFile(old.id);
        log(`removed old backup ${old.name}`);
      }
    }

    saveState({ ...state, lastSuccessAt: new Date().toISOString(), lastFingerprint: print, lastFile: name, lastError: undefined, lastErrorAt: undefined });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    saveState({ ...state, lastError: message, lastErrorAt: new Date().toISOString() });
    log(`backup failed: ${message}`);
    throw err;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(LOCK_FILE, { force: true });
  }
}
