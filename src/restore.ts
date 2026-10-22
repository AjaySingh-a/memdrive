import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractArchive } from "./archive";
import { WrongPasswordError, decryptFile, isEncryptedFile, keyFromPassword, savedKeyFor } from "./crypto";
import { ROOT_FOLDER, deleteFile, downloadFile, findFolder, listBackups, listFolders, type DriveFile } from "./drive";
import { claudeMemDataDir, machineName, readJson } from "./paths";
import { canPrompt, confirm, readInput } from "./prompt";
import { restorableEntries } from "./snapshot";

const mb = (f: DriveFile) => `${(Number(f.size ?? 0) / 1024 / 1024).toFixed(1)} MB`;
export const isEncryptedName = (name: string) => name.endsWith(".enc");

export async function list(): Promise<void> {
  const root = await findFolder(ROOT_FOLDER);
  const folders = root ? await listFolders(root) : [];
  if (folders.length === 0) {
    console.log("No backups on Google Drive yet. Run: memdrive backup");
    return;
  }
  for (const folder of folders) {
    const here = folder.name === machineName() ? "  (this computer)" : "";
    console.log(`\n${folder.name}${here}`);
    for (const f of await listBackups(folder.id)) {
      const lock = isEncryptedName(f.name) ? "encrypted" : "NOT encrypted";
      console.log(`  ${f.name}  ${mb(f)}  ${new Date(f.createdTime).toLocaleString()}  ${lock}`);
    }
  }
}

// claude-mem's worker holds the databases open; stop it so the swap is clean.
// Claude Code starts it again on the next session.
function stopWorker(dataDir: string): void {
  const pids = new Set<number>();
  const supervisor = readJson<{ processes?: Record<string, { pid?: number }> }>(join(dataDir, "supervisor.json"), {});
  for (const p of Object.values(supervisor.processes ?? {})) if (p.pid) pids.add(p.pid);
  const worker = readJson<{ pid?: number }>(join(dataDir, "worker.pid"), {});
  if (worker.pid) pids.add(worker.pid);
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {}
  }
}

export async function restore(opts: { machine?: string; file?: string; yes?: boolean }): Promise<void> {
  const machine = opts.machine || machineName();
  const root = await findFolder(ROOT_FOLDER);
  const folder = root ? await findFolder(machine, root) : null;
  if (!folder) throw new Error(`no backups found for "${machine}". Run: memdrive list`);
  const backups = await listBackups(folder);
  const chosen = opts.file ? backups.find((b) => b.name === opts.file) : backups[0];
  if (!chosen) throw new Error(opts.file ? `backup "${opts.file}" not found` : `no backups found for "${machine}"`);

  const stage = mkdtempSync(join(tmpdir(), "memdrive-restore-"));
  try {
    console.log(`Downloading ${chosen.name} (${mb(chosen)})...`);
    const downloaded = join(stage, "download");
    await downloadFile(chosen.id, downloaded);
    let archive = downloaded;
    if (isEncryptedFile(downloaded)) {
      archive = join(stage, "backup.tar.gz");
      await decrypt(downloaded, archive);
    }
    await extractArchive(archive, stage);
    const src = join(stage, "claude-mem");
    const db = join(src, "claude-mem.db");
    if (!existsSync(db)) throw new Error("backup does not contain claude-mem.db");
    const check = new Database(db, { readonly: true });
    const result = Object.values(check.query("PRAGMA integrity_check").get() as object)[0];
    const count = (check.query("SELECT count(*) AS n FROM observations").get() as { n: number } | null)?.n;
    check.close();
    if (result !== "ok") throw new Error(`downloaded database failed its integrity check: ${result}`);
    console.log(`Backup is valid: ${count ?? "?"} memories, made ${new Date(chosen.createdTime).toLocaleString()}`);

    const dataDir = claudeMemDataDir();
    if (!opts.yes) {
      const ok = await confirm(`Replace the claude-mem memory in ${dataDir} with this backup? Close Claude Code first.`, false);
      if (!ok) {
        console.log(ok === null ? "Not an interactive terminal: run again with --yes to restore. Nothing changed." : "Cancelled, nothing changed.");
        return;
      }
    }

    let saved: string | null = null;
    if (existsSync(dataDir)) {
      stopWorker(dataDir);
      await Bun.sleep(2000);
      saved = `${dataDir}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      cpSync(dataDir, saved, { recursive: true });
      for (const name of restorableEntries(dataDir)) rmSync(join(dataDir, name), { recursive: true, force: true });
    }
    rmSync(join(src, "memdrive-info.json"), { force: true });
    mkdirSync(dataDir, { recursive: true });
    for (const name of readdirSync(src)) cpSync(join(src, name), join(dataDir, name), { recursive: true });

    console.log("Restore complete.");
    if (saved) console.log(`Your previous memory was saved to ${saved}`);
    console.log("Start Claude Code again; claude-mem picks up the restored memory automatically.");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// Backups made on this computer decrypt with the saved key. Backups from another
// computer (or made before a password change) need their backup password.
async function decrypt(src: string, dst: string): Promise<void> {
  const saved = savedKeyFor(src);
  if (saved) return decryptFile(src, dst, saved);
  const fromEnv = process.env.MEMDRIVE_PASSWORD;
  if (fromEnv) return decryptFile(src, dst, keyFromPassword(src, fromEnv));
  if (!canPrompt()) {
    throw new Error("this backup needs its backup password. Run `memdrive restore` in your own terminal window.");
  }
  for (let attempt = 1; ; attempt++) {
    const password = await readInput("Backup password for this backup: ", { hidden: true });
    if (!password) throw new Error("a backup password is needed to restore this backup");
    try {
      return decryptFile(src, dst, keyFromPassword(src, password));
    } catch (err) {
      if (!(err instanceof WrongPasswordError) || attempt >= 3) throw err;
      console.log("Wrong password, try again.");
    }
  }
}

// Backups made before memdrive 0.2 were not encrypted.
export async function findUnencrypted(): Promise<{ folder: string; file: DriveFile }[]> {
  const root = await findFolder(ROOT_FOLDER);
  if (!root) return [];
  const found: { folder: string; file: DriveFile }[] = [];
  for (const folder of await listFolders(root)) {
    for (const file of await listBackups(folder.id)) {
      if (!isEncryptedName(file.name)) found.push({ folder: folder.name, file });
    }
  }
  return found;
}

export async function deleteUnencrypted(items: { folder: string; file: DriveFile }[]): Promise<void> {
  for (const { folder, file } of items) {
    await deleteFile(file.id);
    console.log(`  deleted ${folder}/${file.name}`);
  }
}
