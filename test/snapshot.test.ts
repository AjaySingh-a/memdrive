import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchive, extractArchive } from "../src/archive";
import { fingerprint, restorableEntries, snapshot } from "../src/snapshot";

let dir: string;
let data: string;
let live: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memdrive-test-"));
  data = join(dir, "data");
  mkdirSync(join(data, "chroma", "abc"), { recursive: true });
  mkdirSync(join(data, "logs"));
  mkdirSync(join(data, "backups"));

  // A live WAL-mode database with an open connection, like claude-mem's worker.
  live = new Database(join(data, "claude-mem.db"));
  live.run("PRAGMA journal_mode = WAL");
  live.run("CREATE TABLE observations (id INTEGER PRIMARY KEY, text TEXT)");
  for (let i = 0; i < 500; i++) live.run("INSERT INTO observations (text) VALUES (?)", [`note ${i}`]);

  const chroma = new Database(join(data, "chroma", "chroma.sqlite3"));
  chroma.run("CREATE TABLE embeddings (id INTEGER)");
  chroma.close();
  writeFileSync(join(data, "chroma", "abc", "data_level0.bin"), "vectors");
  writeFileSync(join(data, "settings.json"), "{}");
  writeFileSync(join(data, "worker.pid"), "{}");
  writeFileSync(join(data, "logs", "worker.log"), "noise");
  writeFileSync(join(data, "backups", "old.db"), "x");
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true });
});

test("snapshot copies live databases consistently and skips machine-local files", () => {
  const out = join(dir, "out");
  const stats = snapshot(data, out);

  expect(stats.databases.sort()).toEqual(["chroma/chroma.sqlite3", "claude-mem.db"].sort());
  expect(existsSync(join(out, "settings.json"))).toBe(true);
  expect(existsSync(join(out, "chroma", "abc", "data_level0.bin"))).toBe(true);
  expect(existsSync(join(out, "worker.pid"))).toBe(false);
  expect(existsSync(join(out, "logs"))).toBe(false);
  expect(existsSync(join(out, "backups"))).toBe(false);
  expect(readdirSync(out).some((f) => f.endsWith("-wal") || f.endsWith("-shm"))).toBe(false);

  const copy = new Database(join(out, "claude-mem.db"), { readonly: true });
  expect((copy.query("SELECT count(*) AS n FROM observations").get() as { n: number }).n).toBe(500);
  copy.close();
});

test("snapshot survives concurrent writes", async () => {
  const writer = setInterval(() => live.run("INSERT INTO observations (text) VALUES ('more')"), 1);
  await Bun.sleep(20);
  const out = join(dir, "out");
  snapshot(data, out);
  clearInterval(writer);
  const copy = new Database(join(out, "claude-mem.db"), { readonly: true });
  const n = (copy.query("SELECT count(*) AS n FROM observations").get() as { n: number }).n;
  expect(n).toBeGreaterThanOrEqual(500);
  copy.close();
});

test("archive round-trips", async () => {
  const stage = join(dir, "stage");
  snapshot(data, join(stage, "claude-mem"));
  await createArchive(join(dir, "b.tar.gz"), stage, "claude-mem");
  const back = join(dir, "back");
  mkdirSync(back);
  await extractArchive(join(dir, "b.tar.gz"), back);
  expect(existsSync(join(back, "claude-mem", "claude-mem.db"))).toBe(true);
  expect(existsSync(join(back, "claude-mem", "chroma", "abc", "data_level0.bin"))).toBe(true);
});

test("fingerprint changes when memory changes", () => {
  const before = fingerprint(data);
  live.run("INSERT INTO observations (text) VALUES ('new')");
  expect(fingerprint(data)).not.toBe(before);
});

test("restore replaces databases with their WAL files but leaves logs alone", () => {
  const entries = restorableEntries(data);
  expect(entries).toContain("claude-mem.db");
  expect(entries).toContain("claude-mem.db-wal");
  expect(entries).toContain("chroma");
  expect(entries).not.toContain("logs");
  expect(entries).not.toContain("worker.pid");
});

test("restore clears orphaned journal files", () => {
  writeFileSync(join(data, "work-view-reviews.db-wal"), "orphan");
  expect(restorableEntries(data)).toContain("work-view-reviews.db-wal");
});

test("missing claude-mem gives a clear error", () => {
  expect(() => snapshot(join(dir, "nope"), join(dir, "out"))).toThrow(/claude-mem/);
});
