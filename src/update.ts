import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractArchive } from "./archive";
import { log } from "./log";
import { loadConfig, loadState, saveState } from "./paths";
import pkg from "../package.json";

// Updates come from GitHub Releases, so only versions the maintainer publishes as a
// release reach users; work in progress on the main branch does not.
export const REPO = process.env.MEMDRIVE_REPO || "AjaySingh-a/memdrive";
const APP_DIR = join(import.meta.dir, "..");
const CHECK_EVERY_MS = 24 * 3600_000;

interface Release {
  tag: string;
  version: string;
  notes: string;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = candidate.replace(/^v/, "").split(".").map(Number);
  const b = current.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export async function latestRelease(): Promise<Release> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `memdrive/${pkg.version}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`could not check for updates (GitHub ${res.status})`);
  const body = (await res.json()) as { tag_name: string; body?: string };
  return { tag: body.tag_name, version: body.tag_name.replace(/^v/, ""), notes: body.body ?? "" };
}

export const isDevelopmentCopy = () => existsSync(join(APP_DIR, ".git"));

// Download the release, swap it in for the current app folder, then let the NEW
// version finish the job (refresh the Claude skill, scheduler, etc.).
export async function update(opts: { quiet?: boolean } = {}): Promise<boolean> {
  const say = opts.quiet ? log : console.log;
  if (isDevelopmentCopy()) {
    say("This memdrive is a development copy (a git checkout). Update it with `git pull` instead.");
    return false;
  }
  const latest = await latestRelease();
  saveState({ ...loadState(), lastUpdateCheckAt: new Date().toISOString(), latestVersion: latest.version });
  if (!isNewer(latest.version, pkg.version)) {
    if (!opts.quiet) console.log(`memdrive ${pkg.version} is up to date.`);
    return false;
  }

  say(`Updating memdrive ${pkg.version} → ${latest.version}...`);
  const stage = mkdtempSync(join(tmpdir(), "memdrive-update-"));
  try {
    const tarball = join(stage, "release.tar.gz");
    const res = await fetch(`https://github.com/${REPO}/archive/refs/tags/${latest.tag}.tar.gz`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`download failed (GitHub ${res.status})`);
    await Bun.write(tarball, res);
    await extractArchive(tarball, stage);
    const extracted = readdirSync(stage).find((n) => n.startsWith("memdrive-"));
    if (!extracted || !existsSync(join(stage, extracted, "src", "cli.ts"))) {
      throw new Error("the downloaded release does not look like memdrive");
    }

    const previous = `${APP_DIR}.previous`;
    rmSync(previous, { recursive: true, force: true });
    try {
      renameSync(APP_DIR, previous);
      renameSync(join(stage, extracted), APP_DIR);
    } catch {
      // Windows can refuse to rename a folder that is in use; copying over it works there.
      if (!existsSync(APP_DIR)) renameSync(previous, APP_DIR);
      cpSync(join(stage, extracted), APP_DIR, { recursive: true, force: true });
    }
    rmSync(previous, { recursive: true, force: true });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  const after = Bun.spawnSync([process.execPath, join(APP_DIR, "src", "cli.ts"), "after-update", pkg.version], {
    stdout: opts.quiet ? "pipe" : "inherit",
    stderr: opts.quiet ? "pipe" : "inherit",
  });
  if (after.exitCode !== 0) say(`after-update step failed: ${after.stderr?.toString().trim()}`);
  say(`memdrive updated to ${latest.version}.`);
  if (!opts.quiet && latest.notes.trim()) {
    console.log(`\nWhat's new in ${latest.version}:\n${latest.notes.trim().split("\n").slice(0, 25).join("\n")}`);
  }
  return true;
}

// Called from scheduled runs: at most once a day, quietly, never throws.
export async function maybeAutoUpdate(): Promise<void> {
  if (loadConfig().autoUpdate === false || isDevelopmentCopy()) return;
  const last = loadState().lastUpdateCheckAt;
  if (last && Date.now() - Date.parse(last) < CHECK_EVERY_MS) return;
  try {
    await update({ quiet: true });
  } catch (err) {
    saveState({ ...loadState(), lastUpdateCheckAt: new Date().toISOString() });
    log(`update check failed: ${err instanceof Error ? err.message : err}`);
  }
}

// Keep the Claude Code skill in sync with the installed version.
export function installSkill(): void {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const dest = join(claudeDir, "skills", "memdrive", "SKILL.md");
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(APP_DIR, "skill", "SKILL.md"), dest);
}
