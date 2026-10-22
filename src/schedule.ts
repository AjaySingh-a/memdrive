import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME_DIR, ensureHomeDir } from "./paths";

// The scheduler wakes memdrive every hour; `backup --if-due` then decides whether a
// backup is actually needed (interval passed and memory changed). Hourly checks mean
// missed runs (laptop asleep, computer off) catch up soon after waking.
const CLI = join(import.meta.dir, "cli.ts");
const BUN = process.execPath;

const LAUNCHD_LABEL = "dev.memdrive.backup";
const LAUNCHD_PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_DIR = join(homedir(), ".config", "systemd", "user");
const SYSTEMD_UNIT = "memdrive-backup";
const CRON_TAG = "# memdrive-backup";
const WINDOWS_TASK = "memdrive backup";
const WINDOWS_SCRIPT = join(HOME_DIR, "scheduled-backup.cmd");

function run(cmd: string[], input?: string): { ok: boolean; out: string } {
  try {
    const p = Bun.spawnSync(cmd, { stdin: input === undefined ? "ignore" : Buffer.from(input), stderr: "pipe" });
    return { ok: p.exitCode === 0, out: p.stdout.toString() + p.stderr.toString() };
  } catch (err) {
    return { ok: false, out: String(err) };
  }
}

const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function macOn(): string {
  const uid = process.getuid!();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(
    LAUNCHD_PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(BUN)}</string>
    <string>${xml(CLI)}</string>
    <string>backup</string>
    <string>--if-due</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(join(HOME_DIR, "scheduler.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(HOME_DIR, "scheduler.log"))}</string>
</dict>
</plist>
`,
  );
  run(["launchctl", "bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
  const r = run(["launchctl", "bootstrap", `gui/${uid}`, LAUNCHD_PLIST]);
  if (!r.ok) throw new Error(`launchctl failed: ${r.out.trim()}`);
  return "macOS LaunchAgent (checks every hour)";
}

function macOff(): void {
  run(["launchctl", "bootout", `gui/${process.getuid!()}/${LAUNCHD_LABEL}`]);
  rmSync(LAUNCHD_PLIST, { force: true });
}

const hasSystemd = () => run(["systemctl", "--user", "show-environment"]).ok;

function linuxOn(): string {
  if (hasSystemd()) {
    mkdirSync(SYSTEMD_DIR, { recursive: true });
    writeFileSync(
      join(SYSTEMD_DIR, `${SYSTEMD_UNIT}.service`),
      `[Unit]\nDescription=memdrive: back up claude-mem to Google Drive\n\n[Service]\nType=oneshot\nExecStart="${BUN}" "${CLI}" backup --if-due\n`,
    );
    writeFileSync(
      join(SYSTEMD_DIR, `${SYSTEMD_UNIT}.timer`),
      `[Unit]\nDescription=memdrive hourly check\n\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=1h\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
    );
    run(["systemctl", "--user", "daemon-reload"]);
    const r = run(["systemctl", "--user", "enable", "--now", `${SYSTEMD_UNIT}.timer`]);
    if (!r.ok) throw new Error(`systemctl failed: ${r.out.trim()}`);
    return "systemd user timer (checks every hour)";
  }
  const current = run(["crontab", "-l"]);
  if (!current.ok && !/no crontab/i.test(current.out)) {
    throw new Error("neither systemd user services nor crontab are available on this system");
  }
  const kept = (current.ok ? current.out : "").split("\n").filter((l) => l && !l.includes(CRON_TAG));
  kept.push(`17 * * * * "${BUN}" "${CLI}" backup --if-due >/dev/null 2>&1 ${CRON_TAG}`);
  const r = run(["crontab", "-"], kept.join("\n") + "\n");
  if (!r.ok) throw new Error(`crontab failed: ${r.out.trim()}`);
  return "cron (checks every hour)";
}

function linuxOff(): void {
  if (existsSync(join(SYSTEMD_DIR, `${SYSTEMD_UNIT}.timer`))) {
    run(["systemctl", "--user", "disable", "--now", `${SYSTEMD_UNIT}.timer`]);
    rmSync(join(SYSTEMD_DIR, `${SYSTEMD_UNIT}.timer`), { force: true });
    rmSync(join(SYSTEMD_DIR, `${SYSTEMD_UNIT}.service`), { force: true });
    run(["systemctl", "--user", "daemon-reload"]);
  }
  const current = run(["crontab", "-l"]);
  if (current.ok && current.out.includes(CRON_TAG)) {
    const kept = current.out.split("\n").filter((l) => l && !l.includes(CRON_TAG));
    run(["crontab", "-"], kept.length ? kept.join("\n") + "\n" : "");
  }
}

function windowsOn(): string {
  // schtasks limits /TR to 261 characters, so the real command lives in a small script.
  // conhost --headless keeps a console window from flashing up every hour.
  ensureHomeDir();
  writeFileSync(WINDOWS_SCRIPT, `@echo off\r\n"${BUN}" "${CLI}" backup --if-due >> "${join(HOME_DIR, "scheduler.log")}" 2>&1\r\n`);
  const r = run([
    "schtasks", "/Create", "/F", "/SC", "HOURLY", "/TN", WINDOWS_TASK,
    "/TR", `conhost.exe --headless "${WINDOWS_SCRIPT}"`,
  ]);
  if (!r.ok) throw new Error(`schtasks failed: ${r.out.trim()}`);
  run(["schtasks", "/Run", "/TN", WINDOWS_TASK]);
  return "Windows Task Scheduler (checks every hour)";
}

function windowsOff(): void {
  run(["schtasks", "/Delete", "/F", "/TN", WINDOWS_TASK]);
  rmSync(WINDOWS_SCRIPT, { force: true });
}

export function scheduleOn(): string {
  if (process.platform === "darwin") return macOn();
  if (process.platform === "win32") return windowsOn();
  return linuxOn();
}

export function scheduleOff(): void {
  if (process.platform === "darwin") macOff();
  else if (process.platform === "win32") windowsOff();
  else linuxOff();
}

export function scheduleStatus(): string {
  if (process.platform === "darwin") {
    return run(["launchctl", "print", `gui/${process.getuid!()}/${LAUNCHD_LABEL}`]).ok ? "on (launchd)" : "off";
  }
  if (process.platform === "win32") {
    return run(["schtasks", "/Query", "/TN", WINDOWS_TASK]).ok ? "on (Task Scheduler)" : "off";
  }
  if (run(["systemctl", "--user", "is-enabled", `${SYSTEMD_UNIT}.timer`]).ok) return "on (systemd timer)";
  return run(["crontab", "-l"]).out.includes(CRON_TAG) ? "on (cron)" : "off";
}
