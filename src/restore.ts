import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractArchive } from "./archive";
import { ROOT_FOLDER, downloadFile, findFolder, listBackups, listFolders, type DriveFile } from "./drive";
import { claudeMemDataDir, machineName, readJson } from "./paths";
import { restorableEntries } from "./snapshot";

const mb = (f: DriveFile) => `${(Number(f.size ?? 0) / 1024 / 1024).toFixed(1)} MB`;

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
      console.log(`  ${f.name}  ${mb(f)}  ${new Date(f.createdTime).toLocaleString()}`);
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
    const archive = join(stage, "backup.tar.gz");
    await downloadFile(chosen.id, archive);
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
      const answer = prompt(`Replace the claude-mem memory in ${dataDir} with this backup? Close Claude Code first. [y/N]`);
      if (answer?.trim().toLowerCase() !== "y") {
        console.log("Cancelled, nothing changed.");
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

