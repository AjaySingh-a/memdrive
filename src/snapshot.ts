import { Database } from "bun:sqlite";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";

// What gets backed up from the claude-mem data dir. Logs, pid files, heartbeats,
// spools and claude-mem's own pre-upgrade backups are machine-local and skipped.
const EXTRA_FILES = ["settings.json", "chroma-sync-state.json", "backfill.json"];
const EXTRA_DIRS = ["chroma", "corpora"];
const SQLITE_SIDE_FILES = ["-wal", "-shm", "-journal"];

const isSideFile = (name: string) => SQLITE_SIDE_FILES.some((s) => name.endsWith(s));

export function isSqlite(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(16);
    readSync(fd, header, 0, 16, 0);
    return header.toString("latin1") === "SQLite format 3\0";
  } finally {
    closeSync(fd);
  }
}

// Consistent copy of a live database. VACUUM INTO reads inside one transaction,
// so it is safe while claude-mem's worker keeps writing.
export function snapshotDatabase(src: string, dst: string): void {
  const db = new Database(src);
  try {
    db.run("PRAGMA busy_timeout = 15000");
    db.run(`VACUUM INTO '${dst.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  const copy = new Database(dst);
  try {
    copy.run("PRAGMA journal_mode = DELETE");
    const row = copy.query("PRAGMA integrity_check").get() as Record<string, string>;
    const result = Object.values(row)[0];
    if (result !== "ok") throw new Error(`integrity check failed for ${src}: ${result}`);
  } finally {
    copy.close();
  }
  for (const s of SQLITE_SIDE_FILES) rmSync(dst + s, { force: true });
}

function snapshotTree(root: string, dir: string, out: string, stats: SnapshotStats): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const src = join(dir, entry.name);
    const dst = join(out, relative(root, src));
    if (entry.isDirectory()) {
      mkdirSync(dst, { recursive: true });
      snapshotTree(root, src, out, stats);
    } else if (entry.isFile() && !isSideFile(entry.name)) {
      if (isSqlite(src)) {
        snapshotDatabase(src, dst);
        stats.databases.push(relative(root, src));
      } else {
        copyFileSync(src, dst);
      }
      stats.files++;
    }
  }
}

export interface SnapshotStats {
  files: number;
  databases: string[];
}

export function snapshot(dataDir: string, out: string): SnapshotStats {
  if (!existsSync(join(dataDir, "claude-mem.db"))) {
    throw new Error(`no claude-mem database found in ${dataDir} — is claude-mem installed?`);
  }
  mkdirSync(out, { recursive: true });
  const stats: SnapshotStats = { files: 0, databases: [] };

  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    const src = join(dataDir, entry.name);
    if (entry.isFile() && !isSideFile(entry.name) && isSqlite(src)) {
      snapshotDatabase(src, join(out, entry.name));
      stats.databases.push(entry.name);
      stats.files++;
    }
  }
  for (const name of EXTRA_FILES) {
    if (existsSync(join(dataDir, name))) {
      copyFileSync(join(dataDir, name), join(out, name));
      stats.files++;
    }
  }
  for (const name of EXTRA_DIRS) {
    const dir = join(dataDir, name);
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      mkdirSync(join(out, name), { recursive: true });
      snapshotTree(dataDir, dir, out, stats);
    }
  }
  return stats;
}

// Cheap change detector so scheduled runs skip uploading when nothing changed.
export function fingerprint(dataDir: string): string {
  const parts: string[] = [];
  for (const name of readdirSync(dataDir)) {
    if (name.endsWith(".db") || name.endsWith(".db-wal")) {
      const s = statSync(join(dataDir, name));
      parts.push(`${name}:${s.size}:${s.mtimeMs}`);
    }
  }
  return parts.sort().join("|");
}

// Files and folders restore replaces in the data dir.
export function restorableEntries(dataDir: string): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    const p = join(dataDir, entry.name);
    // Journal files must never outlive the database they belong to, even orphaned ones.
    if (entry.isFile() && (isSideFile(entry.name) || isSqlite(p))) entries.push(entry.name);
  }
  return [...entries, ...EXTRA_FILES, ...EXTRA_DIRS];
}
